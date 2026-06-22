-- Nexus — Live Rooms: real tribe link + host controls (NEXUS-GAPS.md Phase 4, #39/#38).
begin;
alter table public.nexus_rooms add column if not exists community_id uuid references public.nexus_communities(id) on delete set null;
alter table public.nexus_rooms add column if not exists capacity int;

drop function if exists public.nexus_create_room(text, text, text, text);
create or replace function public.nexus_create_room(
  p_title text, p_topic text default null, p_emoji text default null, p_host_handle text default 'someone',
  p_community uuid default null, p_capacity int default null
) returns public.nexus_rooms language plpgsql security definer set search_path = public as $$
declare r public.nexus_rooms;
begin
  insert into public.nexus_rooms (title, topic, emoji, host_id, host_handle, here_now, peak_here, last_active_at, pulse, community_id, capacity)
  values (
    left(coalesce(nullif(trim(p_title), ''), 'Untitled room'), 80),
    nullif(trim(p_topic), ''), nullif(trim(p_emoji), ''),
    auth.uid(), coalesce(nullif(trim(p_host_handle), ''), 'someone'),
    1, 1, now(), public.nexus_pulse(now(), 1, 1, 0), p_community,
    case when p_capacity is null then null else greatest(2, least(p_capacity, 500)) end
  ) returning * into r;
  return r;
end $$;
grant execute on function public.nexus_create_room(text, text, text, text, uuid, int) to anon, authenticated;

-- Host control: close the room for everyone (host-only).
create or replace function public.nexus_close_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update public.nexus_rooms set here_now = 0, archived_at = now()
  where id = p_room_id and host_id = auth.uid();
end $$;
grant execute on function public.nexus_close_room(uuid) to authenticated;
commit;
