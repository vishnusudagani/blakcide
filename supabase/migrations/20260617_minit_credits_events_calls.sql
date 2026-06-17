-- Minit — credit accounting, event log, and call timestamps.
--
-- Credits: 1 minit = 1 minute of connected talk time. Hard ceiling for everyone:
-- 10 minits/day (resets at Asia/Kolkata midnight) and 30 minits/rolling-7-days.
-- Enforced before a session starts; an in-progress chat is allowed to finish.
-- Duration is measured from activated_at (listener accepts) to ended_at (completed).

alter table public.connect_sessions
  add column if not exists activated_at timestamptz,
  add column if not exists ended_at timestamptz;

-- Lightweight analytics: append-only event log. Insert by the acting user;
-- only admins can read it back (dashboard comes later).
create table if not exists public.minit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  listener_id uuid,
  session_id uuid,
  event text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
alter table public.minit_events enable row level security;
drop policy if exists "me_insert_own" on public.minit_events;
create policy "me_insert_own" on public.minit_events for insert with check (user_id = auth.uid());
drop policy if exists "me_admin_read" on public.minit_events;
create policy "me_admin_read" on public.minit_events for select using (public.is_admin());
create index if not exists minit_events_created_idx on public.minit_events (created_at desc);
create index if not exists minit_events_session_idx on public.minit_events (session_id);

-- Minutes used today (Kolkata midnight boundary) + rolling 7 days, for auth.uid().
create or replace function public.minit_minutes_used()
returns table (today_min numeric, week_min numeric)
language sql security definer stable set search_path = public as $$
  select
    coalesce(sum(extract(epoch from (ended_at - activated_at)) / 60)
      filter (where ended_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')), 0)::numeric as today_min,
    coalesce(sum(extract(epoch from (ended_at - activated_at)) / 60), 0)::numeric as week_min
  from public.connect_sessions
  where user_id = auth.uid()
    and status = 'completed'
    and activated_at is not null and ended_at is not null
    and ended_at >= now() - interval '7 days';
$$;
grant execute on function public.minit_minutes_used() to authenticated, anon;
