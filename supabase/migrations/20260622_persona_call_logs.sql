-- Persona call logs: a transcript of each live (voice) call with a fantasy persona,
-- captured client-side from the live caption stream and saved on hang-up.
-- Owner-only: calls are owner-only today (guests can't call), so the caller IS the owner.
create table if not exists public.persona_call_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  persona_id  uuid not null references public.fantasy_personas(id) on delete cascade,
  transcript  jsonb not null default '[]'::jsonb,   -- [{ you, them }, …]
  turn_count  int   not null default 0,
  started_at  timestamptz,
  ended_at    timestamptz default now(),
  created_at  timestamptz default now()
);

alter table public.persona_call_logs enable row level security;

drop policy if exists "own persona call logs" on public.persona_call_logs;
create policy "own persona call logs" on public.persona_call_logs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists persona_call_logs_persona_idx
  on public.persona_call_logs (user_id, persona_id, created_at desc);
