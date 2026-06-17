-- Human Connect (Minit) — tighten connect_sessions RLS.
--
-- Previously "Anyone can modify connect_sessions" (ALL, true/true) + broad
-- authenticated read/insert/update let any signed-in user read or modify ANY
-- support session (incl. private listener_notes). Scope to the two parties:
-- the seeker (user_id), the listener (auth uid OR their listeners row), + admins.
-- This also stops realtime from leaking every session to every listener's client.

alter table public.connect_sessions enable row level security;

drop policy if exists "Anyone can modify connect_sessions" on public.connect_sessions;
drop policy if exists "Allow authenticated insert to sessions" on public.connect_sessions;
drop policy if exists "Allow authenticated read access to sessions" on public.connect_sessions;
drop policy if exists "Allow authenticated update to sessions" on public.connect_sessions;
drop policy if exists "cs_select_party" on public.connect_sessions;
drop policy if exists "cs_insert_own" on public.connect_sessions;
drop policy if exists "cs_update_party" on public.connect_sessions;

create policy "cs_select_party" on public.connect_sessions for select using (
  user_id = auth.uid()
  or listener_id = auth.uid()
  or listener_id in (select l.id from public.listeners l where l.user_id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);

create policy "cs_insert_own" on public.connect_sessions for insert with check (user_id = auth.uid());

create policy "cs_update_party" on public.connect_sessions for update using (
  user_id = auth.uid()
  or listener_id = auth.uid()
  or listener_id in (select l.id from public.listeners l where l.user_id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);
