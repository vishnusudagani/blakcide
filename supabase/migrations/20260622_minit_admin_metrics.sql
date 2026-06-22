-- Phase 8 (#50): outcomes instrumentation — does Minit actually help? Admin-only.
-- Connect rate · avg wait · repeat rate · mood-lighter rate · safety incidents/1k.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
create or replace function public.minit_admin_metrics()
returns jsonb language plpgsql security definer set search_path = public as $$
declare since timestamptz := now() - interval '30 days'; v jsonb;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  with s as (select * from public.connect_sessions where created_at >= since),
  agg as (
    select
      count(*) as total,
      count(*) filter (where status in ('active','completed')) as connected,
      count(*) filter (where status = 'completed') as completed,
      count(*) filter (where flagged_at is not null) as flagged,
      avg(extract(epoch from (activated_at - created_at))) filter (where activated_at is not null) as avg_wait_s
    from s
  ),
  rep as (
    select count(*) filter (where c > 1)::numeric / nullif(count(*), 0) as repeat_rate
    from (select user_id, count(*) c from public.connect_sessions where status = 'completed' group by user_id) t
  ),
  mood as (
    select
      count(*) filter (where mood = 'great') as lighter,
      count(*) filter (where mood = 'okay') as same,
      count(*) filter (where mood = 'low') as heavy,
      count(*) as total_refl
    from public.minit_reflections where created_at >= since
  ),
  esc as (select count(*) as n from public.minit_escalations where created_at >= since)
  select jsonb_build_object(
    'window_days', 30,
    'total_starts', a.total,
    'connect_rate', case when a.total > 0 then round(a.connected::numeric / a.total, 3) else null end,
    'completed', a.completed,
    'avg_wait_s', round(coalesce(a.avg_wait_s, 0)),
    'repeat_rate', round(coalesce(r.repeat_rate, 0), 3),
    'lighter', m.lighter, 'same', m.same, 'heavy', m.heavy, 'reflections', m.total_refl,
    'mood_lighter_rate', case when m.total_refl > 0 then round(m.lighter::numeric / m.total_refl, 3) else null end,
    'safety_per_1k', case when a.completed > 0 then round((a.flagged + e.n)::numeric / a.completed * 1000, 1) else 0 end
  ) into v from agg a, rep r, mood m, esc e;
  return v;
end $$;
revoke all on function public.minit_admin_metrics() from public, anon;
grant execute on function public.minit_admin_metrics() to authenticated;
