-- CRITICAL safety fix: minit_escalate authorisation check was broken, so the
-- senior-listener crisis escalation never worked (0 escalations ever in prod).
--
-- connect_sessions.listener_id stores the listeners.id ROW id (that's what
-- minit_start_session inserts and what every RLS policy treats it as), NOT the
-- listener's auth uid. The original check compared listener_id <> auth.uid(),
-- which is ALWAYS true for a listener (a listeners.id never equals an auth uid),
-- so minit_escalate always raised 'not your session'. The listener console's
-- "Escalate to a senior" button (listen.astro) therefore always failed silently.
--
-- Fix: authorise the caller when the session's listener-row belongs to them —
-- the same pattern used by the connect_sessions RLS policies
-- (listener_id in (select l.id from listeners l where l.user_id = auth.uid())).
--
-- Apply to prod with the Supabase MCP apply_migration; this file is the repo record.

create or replace function public.minit_escalate(p_session uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_listener uuid;
begin
  select listener_id into v_listener from public.connect_sessions where id = p_session;
  -- The caller is the listener on this session when the session's listener-row
  -- (listeners.id) belongs to their auth user. (Was: v_listener <> auth.uid(),
  -- comparing a listeners.id to an auth uid — never matched.)
  if v_listener is null or not exists (
    select 1 from public.listeners l where l.id = v_listener and l.user_id = auth.uid()
  ) then
    raise exception 'not your session';
  end if;
  insert into public.minit_escalations (session_id, raised_by, note)
    values (p_session, auth.uid(), p_note);
  update public.connect_sessions
    set flagged_at = coalesce(flagged_at, now()), flag_reason = 'escalated'
    where id = p_session;
end $$;

revoke all on function public.minit_escalate(uuid, text) from public, anon;
grant execute on function public.minit_escalate(uuid, text) to authenticated;
