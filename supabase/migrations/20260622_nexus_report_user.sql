-- Nexus — let nexus_report resolve a 'user' report by per-tribe token (for the DM
-- header's report action, where there's no single message id). Additive patch.

begin;

create or replace function public.nexus_report(
  p_target_type text, p_target_id uuid, p_community uuid, p_reason text, p_details text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_reported uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if p_target_type = 'post' then
    select author_user_id into v_reported from public.nexus_posts where id = p_target_id;
  elsif p_target_type = 'comment' then
    select author_user_id into v_reported from public.nexus_comments where id = p_target_id;
  elsif p_target_type = 'dm' then
    select sender_user_id into v_reported from public.nexus_dm_messages where id = p_target_id;
  elsif p_target_type = 'user' then
    select user_id into v_reported from public.nexus_anonymous_handles
      where token = p_target_id and community_id = p_community;
  end if;
  insert into public.nexus_reports
    (reporter_user_id, target_type, target_id, reported_user_id, community_id, reason, details)
  values
    (v_uid, p_target_type, p_target_id, v_reported, p_community, p_reason, nullif(p_details, ''));
end;
$$;
grant execute on function public.nexus_report(text, uuid, uuid, text, text) to authenticated;

commit;
