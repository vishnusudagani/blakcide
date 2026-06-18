-- Minit: let the seeker see who they matched with (Rapido-style "Connecting to Raj").
-- listeners is own-row RLS, so the seeker reads the matched listener's name via this
-- curated SECURITY DEFINER lookup, scoped to a session they own.
create or replace function public.minit_session_listener(sid uuid)
returns table (display_name text, profile_pic text)
language sql security definer stable set search_path = public as $$
  select l.display_name, l.profile_pic
  from public.connect_sessions s
  join public.listeners l on l.id = s.listener_id
  where s.id = sid and s.user_id = auth.uid();
$$;
grant execute on function public.minit_session_listener(uuid) to authenticated;
revoke execute on function public.minit_session_listener(uuid) from public;
