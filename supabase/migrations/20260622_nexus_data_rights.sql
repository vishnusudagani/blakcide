-- Nexus — self-serve data export + delete (NEXUS-GAPS.md Phase 1, #15; DPDP/GDPR).
-- Owner-scoped SECURITY DEFINER RPCs: a user can download everything Nexus knows
-- about them, or erase their Nexus footprint. (Account-wide deletion is separate.)

begin;

create or replace function public.nexus_export_my_data()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'handles',     (select coalesce(jsonb_agg(jsonb_build_object('community_id', community_id, 'handle', handle)), '[]')
                      from public.nexus_anonymous_handles where user_id = auth.uid()),
    'memberships', (select coalesce(jsonb_agg(community_id), '[]')
                      from public.nexus_community_members where user_id = auth.uid()),
    'posts',       (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'community_id', community_id, 'title', title, 'body', body, 'created_at', created_at)), '[]')
                      from public.nexus_posts where author_user_id = auth.uid()),
    'comments',    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'post_id', post_id, 'body', body, 'created_at', created_at)), '[]')
                      from public.nexus_comments where author_user_id = auth.uid()),
    'impacts',     (select coalesce(jsonb_agg(jsonb_build_object('post_id', post_id, 'comment_id', comment_id, 'type', impact_type, 'created_at', created_at)), '[]')
                      from public.nexus_impacts where user_id = auth.uid()),
    'dms_sent',    (select coalesce(jsonb_agg(jsonb_build_object('community_id', community_id, 'body', body, 'created_at', created_at)), '[]')
                      from public.nexus_dm_messages where sender_user_id = auth.uid()),
    'blocks',      (select count(*) from public.nexus_blocks where blocker_user_id = auth.uid()),
    'reports',     (select coalesce(jsonb_agg(jsonb_build_object('target_type', target_type, 'reason', reason, 'created_at', created_at)), '[]')
                      from public.nexus_reports where reporter_user_id = auth.uid())
  );
$$;
grant execute on function public.nexus_export_my_data() to authenticated;

create or replace function public.nexus_delete_my_data()
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  delete from public.nexus_dm_messages     where sender_user_id = v_uid or recipient_user_id = v_uid;
  delete from public.nexus_dm_threads       where user_a = v_uid or user_b = v_uid;
  delete from public.nexus_impacts          where user_id = v_uid;
  delete from public.nexus_comments         where author_user_id = v_uid;
  delete from public.nexus_posts            where author_user_id = v_uid;  -- cascades remaining comments/impacts
  delete from public.nexus_community_members where user_id = v_uid;
  delete from public.nexus_anonymous_handles where user_id = v_uid;
  delete from public.nexus_blocks           where blocker_user_id = v_uid or blocked_user_id = v_uid;
  delete from public.nexus_reports          where reporter_user_id = v_uid;
  delete from public.nexus_crisis_events    where user_id = v_uid;
end;
$$;
grant execute on function public.nexus_delete_my_data() to authenticated;

commit;
