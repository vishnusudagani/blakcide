-- Nexus — analytics/metrics (NEXUS-GAPS.md Phase 7, #50). is_admin-gated snapshot
-- of the headline numbers (no more flying blind). Computed from existing tables.
begin;
create or replace function public.nexus_admin_metrics()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'tribes',       (select count(*) from public.nexus_communities where archived_at is null),
    'posts',        (select count(*) from public.nexus_posts where is_soft_hidden = false),
    'comments',     (select count(*) from public.nexus_comments where is_soft_hidden = false),
    'rooms_live',   (select count(*) from public.nexus_rooms where archived_at is null and here_now > 0),
    'dms',          (select count(*) from public.nexus_dm_messages),
    'active_7d',    (select count(distinct uid) from (
                       select author_user_id as uid, created_at from public.nexus_posts
                       union all select author_user_id, created_at from public.nexus_comments
                     ) a where created_at > now() - interval '7 days'),
    'open_reports', (select count(*) from public.nexus_reports where status = 'open'),
    'crisis_30d',   (select count(*) from public.nexus_crisis_events where created_at > now() - interval '30 days')
  ) into v;
  return v;
end; $$;
grant execute on function public.nexus_admin_metrics() to authenticated;
commit;
