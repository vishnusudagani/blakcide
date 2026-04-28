-- "The Pulse" — contextual, gentle feedback collection.
--
-- Two tables:
--   global_settings     — key/value flags the admin flips at runtime.
--                         Single source of truth for "is the pulse on?".
--   blaksyd_pulse_logs  — every individual pulse the user leaves behind.
--                         Anonymous-allowed (user_id nullable) so a logged-out
--                         visitor can still drop a vibe.
--
-- Why this is its own surface and not part of the symp_* schema: feedback is
-- platform-wide product signal, not a Symp brain artefact. Keeping it in a
-- vanilla public.* namespace also means the admin dashboard can read it via
-- standard PostgREST without going through the Symp API key.

-- ── 1. global_settings (key/value) ─────────────────────────────────────────
create table if not exists public.global_settings (
    key         text primary key,
    value       jsonb       not null default '{}'::jsonb,
    updated_at  timestamptz not null default now(),
    updated_by  uuid        references auth.users(id) on delete set null
);

-- Seed the master switch — default OFF so we don't surprise users on rollout.
insert into public.global_settings (key, value)
values ('pulse_active', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;

-- Touch trigger keeps updated_at honest.
create or replace function public.touch_global_settings_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_global_settings_touch on public.global_settings;
create trigger trg_global_settings_touch
before update on public.global_settings
for each row execute function public.touch_global_settings_updated_at();

alter table public.global_settings enable row level security;

-- Anyone (incl. anon) can READ — the frontend needs to know if pulse is on.
drop policy if exists "global_settings_read_all" on public.global_settings;
create policy "global_settings_read_all"
    on public.global_settings for select
    using (true);

-- Only admins write. The Symp admin function uses the service role anyway,
-- so this policy mostly protects against a leaked anon key.
drop policy if exists "global_settings_admin_write" on public.global_settings;
create policy "global_settings_admin_write"
    on public.global_settings for all
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));


-- ── 2. blaksyd_pulse_logs (the feedback rows) ──────────────────────────────
create table if not exists public.blaksyd_pulse_logs (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid             references auth.users(id) on delete set null,
    page_context  text             not null,
    vibe_rating   text             not null,
    feedback_text text,
    user_agent    text,
    created_at    timestamptz      not null default now(),

    constraint pulse_page_context_chk
        check (page_context in ('journal','ai_echo','human_connect','community','dashboard','other')),
    constraint pulse_vibe_rating_chk
        check (vibe_rating in ('calm','glitchy','needs_something')),
    constraint pulse_feedback_len_chk
        check (feedback_text is null or char_length(feedback_text) <= 500)
);

create index if not exists pulse_logs_created_at_idx
    on public.blaksyd_pulse_logs (created_at desc);

create index if not exists pulse_logs_page_context_idx
    on public.blaksyd_pulse_logs (page_context, created_at desc);

create index if not exists pulse_logs_user_id_idx
    on public.blaksyd_pulse_logs (user_id, created_at desc)
    where user_id is not null;

alter table public.blaksyd_pulse_logs enable row level security;

-- Anyone (anon or signed-in) can INSERT a pulse — that's the point of the
-- feedback collector. The handler on the server side enforces shape via the
-- check constraints above.
drop policy if exists "pulse_insert_anyone" on public.blaksyd_pulse_logs;
create policy "pulse_insert_anyone"
    on public.blaksyd_pulse_logs for insert
    with check (true);

-- Only admins can read the inbox. Regular users never need to query their
-- own pulses (this isn't a journal — it's anonymous-by-default feedback).
drop policy if exists "pulse_read_admin_only" on public.blaksyd_pulse_logs;
create policy "pulse_read_admin_only"
    on public.blaksyd_pulse_logs for select
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
