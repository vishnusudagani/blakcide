-- Human Connect (Minit) — hardening: presence, private notes, report flags, TTLs.

-- Presence: listeners heartbeat last_seen; seekers ignore stale-online listeners.
alter table public.listeners add column if not exists last_seen timestamptz;

-- Private listener notes. connect_sessions.listener_notes is readable by the
-- seeker (they own the row), so real private notes need their own table.
create table if not exists public.minit_listener_notes (
  session_id uuid primary key references public.connect_sessions(id) on delete cascade,
  listener_user_id uuid not null,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.minit_listener_notes enable row level security;
drop policy if exists "mln_rw" on public.minit_listener_notes;
create policy "mln_rw" on public.minit_listener_notes for all
  using (listener_user_id = auth.uid())
  with check (listener_user_id = auth.uid());

-- Report / escalation on a session.
alter table public.connect_sessions
  add column if not exists flagged_at timestamptz,
  add column if not exists flag_reason text;

-- TTLs via pg_cron (named jobs upsert).
select cron.schedule('minit-expire-pending', '* * * * *',
  $$update public.connect_sessions set status='cancelled' where status='pending' and created_at < now() - interval '15 minutes'$$);
select cron.schedule('minit-expire-scheduled', '7 * * * *',
  $$update public.connect_sessions set status='cancelled' where status='scheduled' and created_at < now() - interval '2 days'$$);
select cron.schedule('minit-stale-listeners-offline', '* * * * *',
  $$update public.listeners set is_online=false where is_online=true and last_seen is not null and last_seen < now() - interval '2 minutes'$$);
