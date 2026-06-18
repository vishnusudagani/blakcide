-- Minit — clear the security_definer_view advisor + lock RPCs to authenticated.

-- listeners_public is unused until Listener Discovery (Phase 3b); make it respect
-- RLS now (clears the security_definer_view ERROR). Discovery will expose the
-- directory via a dedicated SECURITY DEFINER RPC returning safe columns of all
-- listeners instead of a definer view.
alter view public.listeners_public set (security_invoker = on);

-- These all self-check (auth.uid()/is_admin), but don't leave them callable by
-- anon/public. Trigger functions shouldn't be RPC-callable at all.
revoke execute on function public.connect_sessions_guard() from public;
revoke execute on function public.trg_cs_freed() from public;
revoke execute on function public.trg_listener_online() from public;
revoke execute on function public.minit_notify_next_callback(uuid) from public;
revoke execute on function public.minit_start_session(uuid, boolean, jsonb) from public;
revoke execute on function public.minit_available_count() from public;
revoke execute on function public.minit_queue_position(uuid) from public;
revoke execute on function public.minit_request_callback(uuid, boolean) from public;
revoke execute on function public.admin_provision_listener(text, text, text[], text, text[], text, text) from public;
