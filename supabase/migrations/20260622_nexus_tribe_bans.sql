-- Nexus — tribe ban-member (completes NEXUS-GAPS.md Phase 1, #6).
-- A moderator can ban a member from their tribe: removes membership, hides their
-- posts in that tribe, and BEFORE INSERT triggers block them from re-posting or
-- re-joining (enforced in BOTH legacy + proxy paths). RLS-locked bans table.

begin;

create table if not exists public.nexus_tribe_bans (
  community_id uuid not null references public.nexus_communities(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  banned_by    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (community_id, user_id)
);
alter table public.nexus_tribe_bans enable row level security;  -- definer-only; no client grants

create or replace function public.nexus_is_banned(p_community uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.nexus_tribe_bans where community_id = p_community and user_id = p_user);
$$;
grant execute on function public.nexus_is_banned(uuid, uuid) to anon, authenticated;

create or replace function public.nexus_mod_ban(p_community uuid, p_other_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if not public.nexus_is_moderator(p_community, v_uid) then
    raise exception 'not a moderator' using errcode = '42501'; end if;
  select user_id into v_other from public.nexus_anonymous_handles
    where token = p_other_token and community_id = p_community;
  if v_other is null or v_other = v_uid then return; end if;
  if public.nexus_is_moderator(p_community, v_other) then return; end if;  -- never ban a fellow mod
  insert into public.nexus_tribe_bans (community_id, user_id, banned_by)
    values (p_community, v_other, v_uid) on conflict do nothing;
  delete from public.nexus_community_members where community_id = p_community and user_id = v_other;
  update public.nexus_posts set is_soft_hidden = true
    where community_id = p_community and author_user_id = v_other;
end;
$$;
grant execute on function public.nexus_mod_ban(uuid, uuid) to authenticated;

-- Enforcement: banned users can't post, comment, or re-join the tribe (both modes).
create or replace function public._nexus_ban_block_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_ai_author is not true and public.nexus_is_banned(new.community_id, new.author_user_id) then
    raise exception 'banned from this tribe' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_nexus_ban_block_post on public.nexus_posts;
create trigger trg_nexus_ban_block_post before insert on public.nexus_posts
  for each row execute function public._nexus_ban_block_post();

create or replace function public._nexus_ban_block_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_comm uuid;
begin
  if new.is_ai_author is true then return new; end if;
  select community_id into v_comm from public.nexus_posts where id = new.post_id;
  if v_comm is not null and public.nexus_is_banned(v_comm, new.author_user_id) then
    raise exception 'banned from this tribe' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_nexus_ban_block_comment on public.nexus_comments;
create trigger trg_nexus_ban_block_comment before insert on public.nexus_comments
  for each row execute function public._nexus_ban_block_comment();

create or replace function public._nexus_ban_block_join() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.nexus_is_banned(new.community_id, new.user_id) then
    raise exception 'banned from this tribe' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_nexus_ban_block_join on public.nexus_community_members;
create trigger trg_nexus_ban_block_join before insert on public.nexus_community_members
  for each row execute function public._nexus_ban_block_join();

commit;
