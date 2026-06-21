-- In-app reminders / nudges. The user tells Blak "remind me to …"; Blak stores a
-- row here and surfaces it on the home screen once it's due (no push needed).
-- Owner-only RLS — the browser reads/writes its own rows directly.

create table if not exists public.blak_reminders (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null,
    text       text not null,
    remind_at  timestamptz not null,
    done       boolean not null default false,
    created_at timestamptz not null default now()
);

alter table public.blak_reminders enable row level security;

drop policy if exists "own reminders" on public.blak_reminders;
create policy "own reminders" on public.blak_reminders
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists blak_reminders_due_idx
    on public.blak_reminders (user_id, done, remind_at);
