-- Nexus server-proxy — FINAL leak-close (the cutover step). ⚠️ DO NOT APPLY YET.
--
-- Run this ONLY after:
--   1. the proxy frontend is deployed to prod (PUBLIC_NEXUS_PROXY=1 in Netlify), and
--   2. a logged-in pass confirms feed / post / comment / resonance / DM all work.
--
-- It removes direct base-table access so every identity-bearing read goes through
-- the views and every write through the RPCs — that's the moment the cross-tribe
-- de-anonymisation leak (#12/#13/#14) is fully, irreversibly closed. Applying it
-- before the proxy frontend is live WILL break the legacy beta. The SECURITY
-- DEFINER RPCs keep working (they run as owner), as do rooms/tribes/membership
-- (their tables are intentionally left readable — no identity leak there).

begin;

-- Posts & comments: reads → views, writes → RPCs.
revoke select, insert, update, delete on public.nexus_posts    from anon, authenticated;
revoke select, insert, update, delete on public.nexus_comments from anon, authenticated;

-- Impacts: counts live on the post; resonance toggles via nexus_set_resonance.
-- Revoking direct access also closes #13 (you could otherwise see WHO resonated).
revoke select, insert, update, delete on public.nexus_impacts  from anon, authenticated;

-- Handles: the raw user_id lives here. Clients only ever get the opaque token via
-- the views / nexus_handle_public. Never readable directly.
revoke select, insert, update, delete on public.nexus_anonymous_handles from anon, authenticated;

-- DMs: sending goes through nexus_send_dm. NOTE: we keep SELECT (RLS already limits
-- rows to the two participants) so the existing DM realtime subscription keeps
-- firing — the client only uses that event to REFETCH via nexus_dm_thread and never
-- renders the payload's raw uids. Full DM-uid hardening lands when DM realtime moves
-- to a broadcast channel (Phase 3/4); until then this is the only residual.
revoke insert, update, delete on public.nexus_dm_messages from anon, authenticated;

commit;
