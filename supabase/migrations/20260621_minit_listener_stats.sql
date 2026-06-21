-- Phase 4c (#32): listener dashboard — the calling listener's own stats, including
-- the "what helped" breakdown. SECURITY DEFINER so it can read across the listener's
-- sessions/reviews without per-table read policies; scoped strictly to auth.uid().
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
create or replace function public.minit_listener_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lid uuid; v_today int; v_week int; v_all int; v_helped jsonb;
begin
  select id into v_lid from public.listeners where user_id = auth.uid();
  if v_lid is null then return jsonb_build_object('listener', false); end if;
  select count(*) into v_today from public.connect_sessions where listener_id = v_lid and status = 'completed' and created_at >= date_trunc('day', now());
  select count(*) into v_week  from public.connect_sessions where listener_id = v_lid and status = 'completed' and created_at >= date_trunc('week', now());
  select count(*) into v_all   from public.connect_sessions where listener_id = v_lid and status = 'completed';
  select coalesce(jsonb_agg(jsonb_build_object('tag', tag, 'n', n)), '[]'::jsonb) into v_helped
    from (select unnest(helped) as tag, count(*) as n
          from public.listener_reviews where listener_id = v_lid and helped is not null
          group by 1 order by 2 desc limit 4) t;
  return jsonb_build_object('listener', true, 'today', v_today, 'week', v_week, 'alltime', v_all, 'helped', v_helped);
end $$;
revoke all on function public.minit_listener_stats() from public, anon;
grant execute on function public.minit_listener_stats() to authenticated;
