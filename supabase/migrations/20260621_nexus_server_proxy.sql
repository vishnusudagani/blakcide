-- Nexus — server-proxy identity layer (Phase 0 of NEXUS-GAPS.md).
--
-- Closes the cross-tribe de-anonymisation leak (#12/#13/#14): today the browser
-- reads nexus_posts/comments/dm_messages directly and so receives every author's
-- RAW auth.users.id, which makes the same person linkable across tribes despite
-- different per-tribe handles. This migration introduces the surface the ORIGINAL
-- schema always intended (see 20260427_nexus.sql lines 33-37): the browser reads
-- identity-safe VIEWS (raw user_id never selected; an opaque per-tribe `token`
-- stands in) and writes through SECURITY DEFINER RPCs.
--
-- ADDITIVE + REVERSIBLE: base-table grants are NOT revoked here, so the current
-- live beta (which talks to the base tables) keeps working untouched. The browser
-- only switches to these views/RPCs behind the PUBLIC_NEXUS_PROXY flag (default
-- off). A follow-up migration revokes base-table access once the flag is flipped
-- and verified — that is the moment the leak is fully closed.
--
-- Handle minting is best-effort via AFTER-INSERT triggers wrapped in an exception
-- guard, so a minting hiccup can NEVER block a post/comment/DM insert.

begin;

-- ── 1. Opaque per-tribe token on the existing handle table ──────────────────
alter table public.nexus_anonymous_handles
  add column if not exists token uuid not null default gen_random_uuid();
create unique index if not exists uniq_nexus_handle_token
  on public.nexus_anonymous_handles (token);

-- ── 2. Server-side handle minting (calm adjective-noun-NN, matches live UI) ──
-- SECURITY DEFINER so it can write the handle row regardless of caller. Stable
-- per (community,user); collision-safe within a community.
create or replace function public._nexus_mint_handle(p_community uuid, p_user uuid)
returns public.nexus_anonymous_handles
language plpgsql security definer set search_path = public as $$
declare
  adjs  text[] := array['quiet','warm','steady','night','soft','open','kind','calm','bright','still','easy','true','gentle','lucid','amber','golden','hidden','distant','velvet','lunar','drifting','slow','mellow','wandering'];
  nouns text[] := array['harbor','signal','ember','meadow','tide','comet','willow','lantern','river','pine','spark','haven','cedar','orchard','thicket','current','beacon','hollow','summit','delta','cove','aurora','marsh','dune'];
  v_row    public.nexus_anonymous_handles;
  v_handle text;
  v_seed   text;
  i        int;
begin
  select * into v_row from public.nexus_anonymous_handles
    where community_id = p_community and user_id = p_user;
  if found then return v_row; end if;

  for i in 1..8 loop
    v_handle := adjs[1 + floor(random() * array_length(adjs, 1))::int] || '-'
             || nouns[1 + floor(random() * array_length(nouns, 1))::int] || '-'
             || (10 + floor(random() * 90)::int)::text;
    v_seed := substr(md5(p_user::text || p_community::text || v_handle), 1, 8);
    begin
      insert into public.nexus_anonymous_handles (community_id, user_id, handle, avatar_seed)
        values (p_community, p_user, v_handle, v_seed)
        returning * into v_row;
      return v_row;
    exception when unique_violation then
      -- (community,user) race → row now exists; else (community,handle) clash → retry
      select * into v_row from public.nexus_anonymous_handles
        where community_id = p_community and user_id = p_user;
      if found then return v_row; end if;
    end;
  end loop;

  -- last resort: near-unique suffix, never collides on (community,user)
  v_handle := 'member-' || substr(replace(p_user::text, '-', ''), 1, 6)
           || '-' || (100 + floor(random() * 900)::int)::text;
  v_seed := substr(md5(p_user::text || p_community::text), 1, 8);
  insert into public.nexus_anonymous_handles (community_id, user_id, handle, avatar_seed)
    values (p_community, p_user, v_handle, v_seed)
    on conflict (community_id, user_id) do update set handle = excluded.handle
    returning * into v_row;
  return v_row;
end;
$$;

-- ── 3. Best-effort mint triggers (never block the underlying insert) ────────
-- Blak (the synthetic member) is rendered specially and gets no handle.
create or replace function public._nexus_post_mint() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_ai_author is not true
     and new.author_user_id <> 'b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab'::uuid then
    perform public._nexus_mint_handle(new.community_id, new.author_user_id);
  end if;
  return null;
exception when others then
  return null;
end;
$$;
drop trigger if exists trg_nexus_post_mint on public.nexus_posts;
create trigger trg_nexus_post_mint after insert on public.nexus_posts
  for each row execute function public._nexus_post_mint();

create or replace function public._nexus_comment_mint() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_comm uuid;
begin
  if new.is_ai_author is not true
     and new.author_user_id <> 'b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab'::uuid then
    select community_id into v_comm from public.nexus_posts where id = new.post_id;
    if v_comm is not null then
      perform public._nexus_mint_handle(v_comm, new.author_user_id);
    end if;
  end if;
  return null;
exception when others then
  return null;
end;
$$;
drop trigger if exists trg_nexus_comment_mint on public.nexus_comments;
create trigger trg_nexus_comment_mint after insert on public.nexus_comments
  for each row execute function public._nexus_comment_mint();

create or replace function public._nexus_dm_mint() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public._nexus_mint_handle(new.community_id, new.sender_user_id);
  perform public._nexus_mint_handle(new.community_id, new.recipient_user_id);
  return null;
exception when others then
  return null;
end;
$$;
drop trigger if exists trg_nexus_dm_mint on public.nexus_dm_messages;
create trigger trg_nexus_dm_mint after insert on public.nexus_dm_messages
  for each row execute function public._nexus_dm_mint();

-- ── 4. Backfill handles for everyone who already posted/commented/DMed ──────
do $$
declare r record;
begin
  for r in select distinct community_id, author_user_id as uid from public.nexus_posts
           where is_ai_author is not true
             and author_user_id <> 'b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab'::uuid loop
    perform public._nexus_mint_handle(r.community_id, r.uid);
  end loop;
  for r in select distinct p.community_id as community_id, c.author_user_id as uid
           from public.nexus_comments c join public.nexus_posts p on p.id = c.post_id
           where c.is_ai_author is not true
             and c.author_user_id <> 'b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab'::uuid loop
    perform public._nexus_mint_handle(r.community_id, r.uid);
  end loop;
  for r in select community_id, uid from (
             select community_id, sender_user_id as uid from public.nexus_dm_messages
             union
             select community_id, recipient_user_id as uid from public.nexus_dm_messages
           ) q loop
    perform public._nexus_mint_handle(r.community_id, r.uid);
  end loop;
end $$;

-- ── 5. Identity-safe READ views (security_invoker → caller's RLS still applies)
-- Raw author_user_id is NEVER selected. `author_token` is the opaque per-tribe id.
create or replace view public.nexus_posts_view with (security_invoker = true) as
  select p.id, p.community_id, p.is_ai_author, p.title, p.body, p.image_url,
         p.impact_count, p.comment_count, p.created_at, p.updated_at,
         h.token                  as author_token,
         coalesce(h.handle, '')    as author_handle,
         coalesce(h.avatar_seed,'') as avatar_seed,
         (p.author_user_id = auth.uid()) as is_mine,
         exists (select 1 from public.nexus_impacts i
                 where i.post_id = p.id and i.user_id = auth.uid()
                   and i.impact_type = 'resonated') as my_resonated
  from public.nexus_posts p
  left join public.nexus_anonymous_handles h
    on h.community_id = p.community_id and h.user_id = p.author_user_id
  where p.is_soft_hidden = false;
grant select on public.nexus_posts_view to anon, authenticated;

create or replace view public.nexus_comments_view with (security_invoker = true) as
  select c.id, c.post_id, c.is_ai_author, c.body, c.image_url, c.created_at,
         h.token                   as author_token,
         coalesce(h.handle, '')     as author_handle,
         coalesce(h.avatar_seed, '') as avatar_seed,
         (c.author_user_id = auth.uid()) as is_mine
  from public.nexus_comments c
  join public.nexus_posts p on p.id = c.post_id
  left join public.nexus_anonymous_handles h
    on h.community_id = p.community_id and h.user_id = c.author_user_id
  where c.is_soft_hidden = false;
grant select on public.nexus_comments_view to anon, authenticated;

create or replace view public.nexus_dm_messages_view with (security_invoker = true) as
  select d.id, d.community_id, d.body, d.image_url, d.created_at,
         (d.sender_user_id = auth.uid()) as is_mine,
         case when d.sender_user_id = auth.uid() then hr.token else hs.token end as other_token,
         case when d.sender_user_id = auth.uid()
              then coalesce(hr.handle, '') else coalesce(hs.handle, '') end as other_handle
  from public.nexus_dm_messages d
  left join public.nexus_anonymous_handles hs
    on hs.community_id = d.community_id and hs.user_id = d.sender_user_id
  left join public.nexus_anonymous_handles hr
    on hr.community_id = d.community_id and hr.user_id = d.recipient_user_id
  where d.sender_user_id = auth.uid() or d.recipient_user_id = auth.uid();
grant select on public.nexus_dm_messages_view to authenticated;

-- ── 6. WRITE RPCs (SECURITY DEFINER; enforce auth in-code via auth.uid()) ───
create or replace function public.nexus_create_post(
  p_community uuid, p_title text default null, p_body text default '', p_image_url text default null
) returns public.nexus_posts_view
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_row public.nexus_posts_view;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if coalesce(btrim(coalesce(p_body, '')), '') = '' and p_image_url is null then
    raise exception 'empty post'; end if;
  if not exists (select 1 from public.nexus_communities c where c.id = p_community
                 and (c.visibility = 'public' or public.nexus_is_member(c.id, v_uid))) then
    raise exception 'community not found' using errcode = '42501'; end if;
  insert into public.nexus_community_members (community_id, user_id)
    values (p_community, v_uid) on conflict do nothing;
  perform public._nexus_mint_handle(p_community, v_uid);
  insert into public.nexus_posts (community_id, author_user_id, title, body, image_url)
    values (p_community, v_uid, nullif(btrim(coalesce(p_title, '')), ''), coalesce(p_body, ''), p_image_url)
    returning id into v_id;
  select * into v_row from public.nexus_posts_view where id = v_id;
  return v_row;
end;
$$;
grant execute on function public.nexus_create_post(uuid, text, text, text) to authenticated;

create or replace function public.nexus_create_comment(
  p_post_id uuid, p_body text, p_parent_id uuid default null, p_image_url text default null
) returns public.nexus_comments_view
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_comm uuid; v_id uuid; v_row public.nexus_comments_view;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if coalesce(btrim(coalesce(p_body, '')), '') = '' and p_image_url is null then
    raise exception 'empty comment'; end if;
  select community_id into v_comm from public.nexus_posts where id = p_post_id;
  if v_comm is null then raise exception 'post not found'; end if;
  if not exists (select 1 from public.nexus_communities c where c.id = v_comm
                 and (c.visibility = 'public' or public.nexus_is_member(c.id, v_uid))) then
    raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.nexus_community_members (community_id, user_id)
    values (v_comm, v_uid) on conflict do nothing;
  perform public._nexus_mint_handle(v_comm, v_uid);
  insert into public.nexus_comments (post_id, author_user_id, parent_id, body, image_url)
    values (p_post_id, v_uid, p_parent_id, coalesce(p_body, ''), p_image_url)
    returning id into v_id;
  select * into v_row from public.nexus_comments_view where id = v_id;
  return v_row;
end;
$$;
grant execute on function public.nexus_create_comment(uuid, text, uuid, text) to authenticated;

create or replace function public.nexus_set_resonance(p_post_id uuid, p_on boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_count int;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if p_on then
    insert into public.nexus_impacts (user_id, post_id, impact_type)
      values (v_uid, p_post_id, 'resonated') on conflict do nothing;
  else
    delete from public.nexus_impacts
      where user_id = v_uid and post_id = p_post_id and impact_type = 'resonated';
  end if;
  select impact_count into v_count from public.nexus_posts where id = p_post_id;
  return coalesce(v_count, 0);
end;
$$;
grant execute on function public.nexus_set_resonance(uuid, boolean) to authenticated;

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

-- ── 7. DM read RPCs (so the client never selects raw uids) ──────────────────
create or replace function public.nexus_dm_thread(p_community uuid, p_other_token uuid)
returns setof public.nexus_dm_messages_view
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then return; end if;
  select user_id into v_other from public.nexus_anonymous_handles
    where token = p_other_token and community_id = p_community;
  if v_other is null then return; end if;
  return query
    select dv.* from public.nexus_dm_messages_view dv
    join public.nexus_dm_messages d on d.id = dv.id
    where d.community_id = p_community
      and ((d.sender_user_id = v_uid    and d.recipient_user_id = v_other)
        or (d.sender_user_id = v_other  and d.recipient_user_id = v_uid))
    order by d.created_at asc;
end;
$$;
grant execute on function public.nexus_dm_thread(uuid, uuid) to authenticated;

create or replace function public.nexus_dm_inbox(p_community uuid default null)
returns table(community_id uuid, other_token uuid, other_handle text, last_body text, last_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  return query
  with msgs as (
    select d.*,
           case when d.sender_user_id = v_uid then d.recipient_user_id else d.sender_user_id end as other_uid
    from public.nexus_dm_messages d
    where (d.sender_user_id = v_uid or d.recipient_user_id = v_uid)
      and (p_community is null or d.community_id = p_community)
  ), ranked as (
    select m.*, row_number() over (partition by m.community_id, m.other_uid order by m.created_at desc) rn
    from msgs m
  )
  select r.community_id, h.token,
         coalesce(h.handle, ''),
         coalesce(r.body, case when r.image_url is not null then '📷 image' else '' end),
         r.created_at
  from ranked r
  left join public.nexus_anonymous_handles h
    on h.community_id = r.community_id and h.user_id = r.other_uid
  where r.rn = 1
  order by r.created_at desc
  limit 300;
end;
$$;
grant execute on function public.nexus_dm_inbox(uuid) to authenticated;

commit;
