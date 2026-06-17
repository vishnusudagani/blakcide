-- ════════════════════════════════════════════════════════════════════════════
-- Nexus Live Rooms — ephemeral, presence-driven rooms with a persistent registry
-- and a "Pulse" (collective aliveness) score.
--
-- Supabase Realtime carries the IN-ROOM experience (presence = who's here,
-- broadcast = live chat) with no DB writes per message — which is exactly the
-- "room exists until the last person leaves" model. This table is just the
-- registry + the Pulse history, so the lobby persists and Pulse can accumulate.
--
-- Deliberately ISOLATED from the existing nexus_* community tables (20260427_nexus
-- .sql): Live Rooms are a different, ephemeral concept from Tribes/posts/comments.
--
-- Writes go only through SECURITY DEFINER RPCs (no broad table-write policy).
-- Works for anonymous beta visitors (anon key, RLS-safe) and for signed-in users.
-- Applied to project uoosspumdmffccinszuj (T2MWEB) on 2026-06-13.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.nexus_rooms (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(title) between 1 and 80),
  topic          text check (char_length(topic) <= 140),
  emoji          text check (char_length(emoji) <= 8),
  host_id        uuid references auth.users(id) on delete set null,
  host_handle    text not null default 'someone',
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  here_now       integer not null default 0,
  peak_here      integer not null default 0,
  message_count  integer not null default 0,
  pulse          integer not null default 0,
  archived_at    timestamptz
);

alter table public.nexus_rooms enable row level security;

-- Anyone (incl. anonymous beta visitors) may see the lobby. Writes are RPC-only.
drop policy if exists nexus_rooms_read on public.nexus_rooms;
create policy nexus_rooms_read on public.nexus_rooms for select using (true);

grant select on public.nexus_rooms to anon, authenticated;

-- Pulse: collective, earned aliveness. Rises with days the room has existed, past
-- peak gatherings, sustained messages, and — most of all — people here NOW. When
-- empty (here_now = 0) it stops growing: the room RESTS, it does not die. No
-- countdowns, no streak-loss, no FOMO — warmth while real people are gathered.
create or replace function public.nexus_pulse(p_created timestamptz, p_peak int, p_here int, p_msgs int)
returns integer language sql stable as $$
  select greatest(0, round(
      least(extract(epoch from (now() - p_created)) / 86400.0, 60) * 6   -- days alive (capped at 60)
    + coalesce(p_peak,0) * 5
    + coalesce(p_here,0) * 14
    + coalesce(p_msgs,0) * 1.2
  ))::int
$$;

-- Create a room (host_id = the caller if signed in, else null for anon beta use).
create or replace function public.nexus_create_room(
  p_title text, p_topic text default null, p_emoji text default null, p_host_handle text default 'someone'
) returns public.nexus_rooms language plpgsql security definer set search_path = public as $$
declare r public.nexus_rooms;
begin
  insert into public.nexus_rooms (title, topic, emoji, host_id, host_handle, here_now, peak_here, last_active_at, pulse)
  values (
    left(coalesce(nullif(trim(p_title),''),'Untitled room'), 80),
    nullif(trim(p_topic),''), nullif(trim(p_emoji),''),
    auth.uid(), coalesce(nullif(trim(p_host_handle),''),'someone'),
    1, 1, now(), public.nexus_pulse(now(), 1, 1, 0)
  ) returning * into r;
  return r;
end $$;

-- Heartbeat: a client reports how many are present (+ any new messages). Updates
-- here_now / peak / message_count / last_active and recomputes Pulse. When the
-- reported presence is 0 (a clean leave by the last person), the room is archived
-- → it leaves the lobby ("exists only while people are in it"). Any positive
-- presence keeps it active (archived_at back to null). peak only ever grows.
-- (Clients floor their reported count to 1 while present — you're always here —
-- so here_now only reaches 0 on an actual leave, never a transient sync.)
create or replace function public.nexus_room_heartbeat(
  p_room_id uuid, p_here int, p_msg_delta int default 0
) returns public.nexus_rooms language plpgsql security definer set search_path = public as $$
declare r public.nexus_rooms; new_here int;
begin
  select greatest(0, coalesce(p_here, here_now)) into new_here from public.nexus_rooms where id = p_room_id;
  update public.nexus_rooms set
    here_now       = new_here,
    peak_here      = greatest(peak_here, coalesce(p_here, 0)),
    message_count  = message_count + greatest(0, coalesce(p_msg_delta, 0)),
    last_active_at = now(),
    archived_at    = case when new_here = 0 then now() else null end,
    pulse = public.nexus_pulse(created_at,
              greatest(peak_here, coalesce(p_here,0)),
              new_here,
              message_count + greatest(0, coalesce(p_msg_delta,0)))
  where id = p_room_id
  returning * into r;
  return r;
end $$;

grant execute on function public.nexus_pulse(timestamptz,int,int,int) to anon, authenticated;
grant execute on function public.nexus_create_room(text,text,text,text) to anon, authenticated;
grant execute on function public.nexus_room_heartbeat(uuid,int,int) to anon, authenticated;

-- Lobby subscribes to room inserts/updates in real time.
alter publication supabase_realtime add table public.nexus_rooms;

-- Self-healing: close rooms whose last heartbeat is stale (a client crashed/closed
-- without a clean leave). A room is "active only when users are in it" — so no
-- heartbeat for 2 minutes means nobody's there. Any client calls this on load.
create or replace function public.nexus_sweep_rooms() returns void
language sql security definer set search_path = public as $$
  update public.nexus_rooms
     set here_now = 0, archived_at = coalesce(archived_at, now())
   where here_now > 0
     and last_active_at < now() - interval '2 minutes';
$$;
grant execute on function public.nexus_sweep_rooms() to anon, authenticated;

-- NO SEED DATA. Rooms are ephemeral and exist only while real people are in them:
-- created by a user (host_id = them, here_now = 1), kept alive by heartbeats while
-- occupied, and dropped from the lobby the moment the last person leaves. The
-- lobby only ever shows rooms with here_now > 0.
