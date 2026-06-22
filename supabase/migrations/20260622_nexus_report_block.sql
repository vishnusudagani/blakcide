-- Nexus — report + block (NEXUS-GAPS.md Phase 1, #1/#2). UGC safety primitives.
--
-- Built on the Phase 0 proxy: clients act by opaque per-tribe token (never a uid).
--   • Blocks: you never see content from someone you blocked or who blocked you,
--     and a blocked pair can't DM. Filtered in the views via a SECURITY DEFINER
--     check (so the "they blocked me" direction works without letting you
--     enumerate who blocked you).
--   • Reports: flag a post/comment/dm/room/user with a reason. Reporter-writable,
--     reporter/admin-readable. The moderation queue UI lands with #7.

begin;

-- ── Blocks ──────────────────────────────────────────────────────────────────
create table if not exists public.nexus_blocks (
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  constraint nexus_block_distinct check (blocker_user_id <> blocked_user_id)
);
alter table public.nexus_blocks enable row level security;
drop policy if exists nexus_blocks_self on public.nexus_blocks;
create policy nexus_blocks_self on public.nexus_blocks
  for all using (auth.uid() = blocker_user_id) with check (auth.uid() = blocker_user_id);

-- ── Reports ─────────────────────────────────────────────────────────────────
create table if not exists public.nexus_reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  target_type      text not null check (target_type in ('post','comment','dm','room','user')),
  target_id        uuid,
  reported_user_id uuid references auth.users(id) on delete set null,
  community_id     uuid references public.nexus_communities(id) on delete set null,
  reason           text not null check (reason in ('spam','harassment','hate','sexual','self_harm','violence','misinfo','other')),
  details          text,
  status           text not null default 'open' check (status in ('open','reviewing','actioned','dismissed')),
  created_at       timestamptz not null default now()
);
create index if not exists idx_nexus_reports_open
  on public.nexus_reports (created_at desc) where status = 'open';
alter table public.nexus_reports enable row level security;
drop policy if exists nexus_reports_insert on public.nexus_reports;
create policy nexus_reports_insert on public.nexus_reports
  for insert with check (auth.uid() = reporter_user_id);
drop policy if exists nexus_reports_self_read on public.nexus_reports;
create policy nexus_reports_self_read on public.nexus_reports
  for select using (auth.uid() = reporter_user_id);
-- (admin/moderator read is added with the moderation queue, Phase 1 #7.)

-- ── Block check (bypasses block RLS so views can test BOTH directions) ──────
create or replace function public.nexus_is_blocked(p_viewer uuid, p_other uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.nexus_blocks b
    where (b.blocker_user_id = p_viewer and b.blocked_user_id = p_other)
       or (b.blocker_user_id = p_other  and b.blocked_user_id = p_viewer)
  );
$$;
grant execute on function public.nexus_is_blocked(uuid, uuid) to anon, authenticated;

-- ── RPCs: block / unblock by per-tribe token; report by target ──────────────
create or replace function public.nexus_block(p_community uuid, p_other_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  select user_id into v_other from public.nexus_anonymous_handles
    where token = p_other_token and community_id = p_community;
  if v_other is null or v_other = v_uid then return; end if;
  insert into public.nexus_blocks (blocker_user_id, blocked_user_id)
    values (v_uid, v_other) on conflict do nothing;
end;
$$;
grant execute on function public.nexus_block(uuid, uuid) to authenticated;

create or replace function public.nexus_unblock(p_community uuid, p_other_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  select user_id into v_other from public.nexus_anonymous_handles
    where token = p_other_token and community_id = p_community;
  if v_other is null then return; end if;
  delete from public.nexus_blocks where blocker_user_id = v_uid and blocked_user_id = v_other;
end;
$$;
grant execute on function public.nexus_unblock(uuid, uuid) to authenticated;

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
  end if;
  insert into public.nexus_reports
    (reporter_user_id, target_type, target_id, reported_user_id, community_id, reason, details)
  values
    (v_uid, p_target_type, p_target_id, v_reported, p_community, p_reason, nullif(p_details, ''));
end;
$$;
grant execute on function public.nexus_report(text, uuid, uuid, text, text) to authenticated;

-- ── Wire the block filter into the identity-safe views (same column sets) ───
create or replace view public.nexus_posts_view with (security_invoker = true) as
  select p.id, p.community_id, p.is_ai_author, p.title, p.body, p.image_url,
         p.impact_count, p.comment_count, p.created_at, p.updated_at,
         hp.token as author_token, coalesce(hp.handle,'') as author_handle,
         coalesce(hp.avatar_seed,'') as avatar_seed,
         coalesce(p.author_user_id = auth.uid(), false) as is_mine,
         exists (select 1 from public.nexus_impacts i
                 where i.post_id = p.id and i.user_id = auth.uid()
                   and i.impact_type = 'resonated') as my_resonated
  from public.nexus_posts p
  left join lateral public.nexus_handle_public(p.community_id, p.author_user_id) hp on true
  where p.is_soft_hidden = false
    and not public.nexus_is_blocked(auth.uid(), p.author_user_id);
grant select on public.nexus_posts_view to anon, authenticated;

create or replace view public.nexus_comments_view with (security_invoker = true) as
  select c.id, c.post_id, c.is_ai_author, c.body, c.image_url, c.created_at,
         hp.token as author_token, coalesce(hp.handle,'') as author_handle,
         coalesce(hp.avatar_seed,'') as avatar_seed,
         coalesce(c.author_user_id = auth.uid(), false) as is_mine
  from public.nexus_comments c
  join public.nexus_posts p on p.id = c.post_id
  left join lateral public.nexus_handle_public(p.community_id, c.author_user_id) hp on true
  where c.is_soft_hidden = false
    and not public.nexus_is_blocked(auth.uid(), c.author_user_id);
grant select on public.nexus_comments_view to anon, authenticated;

-- ── A blocked pair can't DM (recreate nexus_send_dm with a block guard) ─────
create or replace function public.nexus_send_dm(
  p_community uuid, p_recipient_token uuid, p_body text default null, p_image_url text default null
) returns public.nexus_dm_messages_view
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_recipient uuid; v_id uuid; v_row public.nexus_dm_messages_view;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if coalesce(btrim(coalesce(p_body, '')), '') = '' and p_image_url is null then
    raise exception 'empty message'; end if;
  select user_id into v_recipient from public.nexus_anonymous_handles
    where token = p_recipient_token and community_id = p_community;
  if v_recipient is null then raise exception 'recipient not found'; end if;
  if v_recipient = v_uid then raise exception 'cannot DM yourself'; end if;
  if public.nexus_is_blocked(v_uid, v_recipient) then
    raise exception 'blocked' using errcode = '42501'; end if;
  if not public.nexus_is_member(p_community, v_uid)
     or not public.nexus_is_member(p_community, v_recipient) then
    raise exception 'both must be members' using errcode = '42501'; end if;
  insert into public.nexus_dm_messages (community_id, sender_user_id, recipient_user_id, body, image_url)
    values (p_community, v_uid, v_recipient, nullif(p_body, ''), p_image_url)
    returning id into v_id;
  select * into v_row from public.nexus_dm_messages_view where id = v_id;
  return v_row;
end;
$$;
grant execute on function public.nexus_send_dm(uuid, uuid, text, text) to authenticated;

commit;
