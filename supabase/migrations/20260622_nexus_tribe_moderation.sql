-- Nexus — tribe-owner moderation (NEXUS-GAPS.md Phase 1, #6).
-- A tribe's moderator (the creator, via nexus_create_tribe's 'moderator' role) can
-- remove a post/comment in their tribe — a soft-hide, so it leaves the public feed
-- but isn't destroyed. Moderator-gated SECURITY DEFINER RPCs.

begin;

create or replace function public.nexus_is_moderator(p_community uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.nexus_community_members
    where community_id = p_community and user_id = p_user and role = 'moderator'
  );
$$;
grant execute on function public.nexus_is_moderator(uuid, uuid) to authenticated;

create or replace function public.nexus_mod_remove_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  select community_id into v_comm from public.nexus_posts where id = p_post_id;
  if v_comm is null then return; end if;
  if not public.nexus_is_moderator(v_comm, v_uid) then
    raise exception 'not a moderator' using errcode = '42501'; end if;
  update public.nexus_posts set is_soft_hidden = true where id = p_post_id;
end;
$$;
grant execute on function public.nexus_mod_remove_post(uuid) to authenticated;

create or replace function public.nexus_mod_remove_comment(p_comment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  select p.community_id into v_comm
    from public.nexus_comments c join public.nexus_posts p on p.id = c.post_id
    where c.id = p_comment_id;
  if v_comm is null then return; end if;
  if not public.nexus_is_moderator(v_comm, v_uid) then
    raise exception 'not a moderator' using errcode = '42501'; end if;
  update public.nexus_comments set is_soft_hidden = true where id = p_comment_id;
end;
$$;
grant execute on function public.nexus_mod_remove_comment(uuid) to authenticated;

commit;
