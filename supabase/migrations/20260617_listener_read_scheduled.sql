-- Human Connect (Minit) — let listeners see scheduled (unclaimed) requests.
--
-- A seeker who can't connect now schedules a session: it's inserted with
-- listener_id = NULL and status = 'scheduled'. The listener dashboard shows
-- these as upcoming requests, but the existing cs_select_party policy only
-- exposes rows where the listener is already the assigned party — so a NULL
-- listener_id row is invisible and the "Scheduled" section stayed empty.
--
-- Add a second permissive SELECT policy (RLS ORs policies together) that lets
-- any authenticated listener read scheduled rows. SECURITY DEFINER helper
-- avoids touching connect_sessions inside its own policy (no recursion).

create or replace function public.uid_is_any_listener() returns boolean
  language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.listeners where user_id = auth.uid());
$$;

drop policy if exists "cs_select_scheduled" on public.connect_sessions;
create policy "cs_select_scheduled" on public.connect_sessions for select using (
  status = 'scheduled' and public.uid_is_any_listener()
);
