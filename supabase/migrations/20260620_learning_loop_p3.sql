-- Learning loop P3 — Minit. Conversations are never stored, so the learning
-- input is the seeker's OWN optional post-session reflection (mood + a short
-- note they choose to share, captured in the existing end-of-session card).
-- (Applied to prod via MCP; this file is the repo record. minit-learn edge fn
-- synthesises a few abstracted, gentle 'inner' themes nightly — SENSITIVE, so
-- they stay in Blak's private lane, never the public Nexus feed.)

create table if not exists public.minit_reflections (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.connect_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  mood       text check (mood in ('great','okay','low','anxious','angry')),
  note       text,
  created_at timestamptz not null default now(),
  unique (session_id)
);
alter table public.minit_reflections enable row level security;
drop policy if exists minit_reflections_owner on public.minit_reflections;
create policy minit_reflections_owner on public.minit_reflections
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists minit_reflections_user_time on public.minit_reflections (user_id, created_at desc);

-- Nightly synthesis (21:45 UTC). Reuses NEXUS_BLAK_CRON_SECRET; URL in Vault.
do $$ begin
  if not exists (select 1 from vault.secrets where name='minit_learn_url') then
    perform vault.create_secret('https://uoosspumdmffccinszuj.supabase.co/functions/v1/minit-learn','minit_learn_url');
  end if;
end $$;
do $$ begin perform cron.unschedule('minit-learn-nightly'); exception when others then null; end $$;
select cron.schedule('minit-learn-nightly', '45 21 * * *', $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'minit_learn_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret')
               ),
    body    := '{}'::jsonb
  );
$cron$);
