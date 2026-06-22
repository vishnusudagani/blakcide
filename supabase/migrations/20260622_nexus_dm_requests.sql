-- Nexus — DM message requests (NEXUS-GAPS.md Phase 1, #10). Anti-harassment:
-- a stranger's first DM lands in the recipient's "Requests", not their inbox.
-- It becomes a normal thread when the recipient accepts — or auto-accepts by
-- replying. Declining blocks further messages from the requester.
--
-- One thread row per (community, sorted-pair). RLS-locked: only the SECURITY
-- DEFINER DM RPCs touch it, so raw uids never reach the client.

begin;

create table if not exists public.nexus_dm_threads (
  community_id uuid not null references public.nexus_communities(id) on delete cascade,
  user_a       uuid not null references auth.users(id) on delete cascade,  -- least(sender,recipient)
  user_b       uuid not null references auth.users(id) on delete cascade,  -- greatest(...)
  status       text not null default 'pending' check (status in ('pending','accepted','declined')),
  requested_by uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (community_id, user_a, user_b),
  constraint nexus_dm_thread_order check (user_a < user_b)
);
alter table public.nexus_dm_threads enable row level security;
-- No policies / no grants: clients never touch this table directly (it holds uids).

-- Backfill: existing conversations are already 'accepted'.
insert into public.nexus_dm_threads (community_id, user_a, user_b, status, requested_by)
select community_id, least(sender_user_id, recipient_user_id), greatest(sender_user_id, recipient_user_id),
       'accepted', sender_user_id
from (select distinct community_id, sender_user_id, recipient_user_id from public.nexus_dm_messages) q
on conflict (community_id, user_a, user_b) do nothing;

-- Send: enforce block + membership, then drive the thread state machine.
create or replace function public.nexus_send_dm(
  p_community uuid, p_recipient_token uuid, p_body text default null, p_image_url text default null
) returns public.nexus_dm_messages_view
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_recipient uuid; v_id uuid; v_row public.nexus_dm_messages_view;
  v_lo uuid; v_hi uuid; v_status text; v_reqby uuid;
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

  v_lo := least(v_uid, v_recipient); v_hi := greatest(v_uid, v_recipient);
  select status, requested_by into v_status, v_reqby from public.nexus_dm_threads
    where community_id = p_community and user_a = v_lo and user_b = v_hi;
  if not found then
    insert into public.nexus_dm_threads (community_id, user_a, user_b, status, requested_by)
      values (p_community, v_lo, v_hi, 'pending', v_uid);
  elsif v_status = 'declined' then
    raise exception 'declined' using errcode = '42501';
  elsif v_status = 'pending' and v_reqby <> v_uid then
    update public.nexus_dm_threads set status = 'accepted', updated_at = now()
      where community_id = p_community and user_a = v_lo and user_b = v_hi;
  end if;

  insert into public.nexus_dm_messages (community_id, sender_user_id, recipient_user_id, body, image_url)
    values (p_community, v_uid, v_recipient, nullif(p_body, ''), p_image_url)
    returning id into v_id;
  select * into v_row from public.nexus_dm_messages_view where id = v_id;
  return v_row;
end;
$$;
grant execute on function public.nexus_send_dm(uuid, uuid, text, text) to authenticated;

-- Accept / decline an incoming request (recipient only).
create or replace function public.nexus_dm_accept(p_community uuid, p_other_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  select user_id into v_other from public.nexus_anonymous_handles
    where token = p_other_token and community_id = p_community;
  if v_other is null then return; end if;
  update public.nexus_dm_threads set status = 'accepted', updated_at = now()
    where community_id = p_community
      and user_a = least(v_uid, v_other) and user_b = greatest(v_uid, v_other)
      and requested_by <> v_uid;  -- only accept requests sent TO me
end;
$$;
grant execute on function public.nexus_dm_accept(uuid, uuid) to authenticated;

create or replace function public.nexus_dm_decline(p_community uuid, p_other_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  select user_id into v_other from public.nexus_anonymous_handles
    where token = p_other_token and community_id = p_community;
  if v_other is null then return; end if;
  update public.nexus_dm_threads set status = 'declined', updated_at = now()
    where community_id = p_community
      and user_a = least(v_uid, v_other) and user_b = greatest(v_uid, v_other)
      and requested_by <> v_uid;
end;
$$;
grant execute on function public.nexus_dm_decline(uuid, uuid) to authenticated;

-- Inbox now carries thread status + an is_request flag (pending AND they started it).
drop function if exists public.nexus_dm_inbox(uuid);
create or replace function public.nexus_dm_inbox(p_community uuid default null)
returns table(community_id uuid, other_token uuid, other_handle text, last_body text, last_at timestamptz, status text, is_request boolean)
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
         r.created_at,
         coalesce(th.status, 'accepted'),
         (coalesce(th.status, 'accepted') = 'pending' and th.requested_by is distinct from v_uid)
  from ranked r
  left join public.nexus_anonymous_handles h
    on h.community_id = r.community_id and h.user_id = r.other_uid
  left join public.nexus_dm_threads th
    on th.community_id = r.community_id
   and th.user_a = least(v_uid, r.other_uid) and th.user_b = greatest(v_uid, r.other_uid)
  where r.rn = 1
    and coalesce(th.status, 'accepted') <> 'declined'
  order by r.created_at desc
  limit 300;
end;
$$;
grant execute on function public.nexus_dm_inbox(uuid) to authenticated;

commit;
