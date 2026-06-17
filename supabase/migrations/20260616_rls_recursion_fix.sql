-- Human Connect (Minit) — fix RLS infinite recursion.
--
-- The scoped connect_sessions policy subqueried `listeners`, whose own policy
-- references connect_sessions, creating a cycle: Postgres raised
--   42P17: infinite recursion detected in policy for relation "connect_sessions"
-- so EVERY read of connect_sessions (and messages, via its connect_sessions
-- subquery) errored — seeker sessions "cut off", listener queue stayed empty,
-- realtime delivered nothing.
--
-- Fix: do the cross-table checks inside SECURITY DEFINER functions, which run as
-- the owner and bypass RLS on the referenced tables, breaking the loop.

create or replace function public.is_admin() returns boolean
  language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.uid_is_listener(lid uuid) returns boolean
  language sql security definer stable set search_path = public as $$
  select lid is not null and exists (select 1 from public.listeners where id = lid and user_id = auth.uid());
$$;

create or replace function public.can_access_session(sid uuid) returns boolean
  language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.connect_sessions s
    where s.id = sid and (
      s.user_id = auth.uid()
      or s.listener_id = auth.uid()
      or exists (select 1 from public.listeners l where l.id = s.listener_id and l.user_id = auth.uid())
    )
  );
$$;

-- Reveal the seeker's name to the matched listener ONLY when they're not anonymous.
create or replace function public.session_seeker_name(sid uuid) returns text
  language sql security definer stable set search_path = public as $$
  select case when s.is_anonymous then null else p.full_name end
  from public.connect_sessions s
  left join public.profiles p on p.id = s.user_id
  where s.id = sid
    and (s.listener_id = auth.uid() or exists (select 1 from public.listeners l where l.id = s.listener_id and l.user_id = auth.uid()));
$$;

drop policy if exists "cs_select_party" on public.connect_sessions;
create policy "cs_select_party" on public.connect_sessions for select using (
  user_id = auth.uid() or listener_id = auth.uid() or public.uid_is_listener(listener_id) or public.is_admin()
);

drop policy if exists "cs_update_party" on public.connect_sessions;
create policy "cs_update_party" on public.connect_sessions for update using (
  user_id = auth.uid() or listener_id = auth.uid() or public.uid_is_listener(listener_id) or public.is_admin()
);

drop policy if exists "Read own chat or session messages" on public.messages;
create policy "Read own chat or session messages" on public.messages for select using (
  (chat_id is not null and exists (select 1 from public.chats c where c.id = messages.chat_id and c.user_id = auth.uid()))
  or (session_id is not null and public.can_access_session(session_id))
);

drop policy if exists "Insert own chat or session messages" on public.messages;
create policy "Insert own chat or session messages" on public.messages for insert with check (
  (chat_id is not null and exists (select 1 from public.chats c where c.id = messages.chat_id and c.user_id = auth.uid()))
  or (session_id is not null and public.can_access_session(session_id))
);
