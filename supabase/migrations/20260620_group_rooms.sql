-- Blak group mediator rooms — ephemeral multi-user rooms with Blak as an active
-- mediator. Created from Blak's "+" button, joined by a short code, real names.
-- NOTE: distinct `blak_group_*` names — the older 2-person `group_rooms`/
-- `group_messages` (20260418, anon-RLS) is a separate feature, left untouched.
-- Blak messages are inserted server-side (service role) by /api/.../group-mediate;
-- members can only insert their own 'user' messages (RLS).

create extension if not exists pgcrypto;

create table if not exists public.blak_group_rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  creator_id  uuid not null references auth.users(id) on delete cascade,
  title       text,
  status      text not null default 'active',   -- 'active' | 'ended'
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create table if not exists public.blak_group_members (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.blak_group_rooms(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text,
  role         text not null default 'member',  -- 'host' | 'member'
  joined_at    timestamptz not null default now(),
  unique (room_id, user_id)
);
create index if not exists blak_group_members_room on public.blak_group_members(room_id);

create table if not exists public.blak_group_messages (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.blak_group_rooms(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,  -- null = Blak
  sender_role  text not null default 'user',    -- 'user' | 'blak' | 'system'
  display_name text,
  content      text not null,
  created_at   timestamptz not null default now()
);
create index if not exists blak_group_messages_room on public.blak_group_messages(room_id, created_at);

-- Membership check as SECURITY DEFINER → avoids RLS recursion on members.
create or replace function public.bg_is_member(p_room uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.blak_group_members m where m.room_id = p_room and m.user_id = auth.uid());
$$;

alter table public.blak_group_rooms    enable row level security;
alter table public.blak_group_members  enable row level security;
alter table public.blak_group_messages enable row level security;

drop policy if exists bgr_select on public.blak_group_rooms;
create policy bgr_select on public.blak_group_rooms for select to authenticated
  using (creator_id = auth.uid() or public.bg_is_member(id));
drop policy if exists bgr_update on public.blak_group_rooms;
create policy bgr_update on public.blak_group_rooms for update to authenticated
  using (creator_id = auth.uid()) with check (creator_id = auth.uid());

drop policy if exists bgm_select on public.blak_group_members;
create policy bgm_select on public.blak_group_members for select to authenticated
  using (public.bg_is_member(room_id));
drop policy if exists bgm_delete on public.blak_group_members;
create policy bgm_delete on public.blak_group_members for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.blak_group_rooms r where r.id = room_id and r.creator_id = auth.uid()));

drop policy if exists bgmsg_select on public.blak_group_messages;
create policy bgmsg_select on public.blak_group_messages for select to authenticated
  using (public.bg_is_member(room_id));
drop policy if exists bgmsg_insert on public.blak_group_messages;
create policy bgmsg_insert on public.blak_group_messages for insert to authenticated
  with check (public.bg_is_member(room_id) and user_id = auth.uid() and sender_role = 'user');

-- ── RPCs (SECURITY DEFINER) ────────────────────────────────────────────────
create or replace function public.bg_create_room(p_title text, p_display_name text)
returns public.blak_group_rooms language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; v_room public.blak_group_rooms; i int := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  loop
    v_code := upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=', 'xyz'), 1, 6));
    begin
      insert into public.blak_group_rooms (code, creator_id, title)
      values (v_code, auth.uid(), nullif(trim(coalesce(p_title,'')),'')) returning * into v_room;
      exit;
    exception when unique_violation then i := i + 1; if i > 8 then raise; end if;
    end;
  end loop;
  insert into public.blak_group_members (room_id, user_id, display_name, role)
  values (v_room.id, auth.uid(), nullif(trim(coalesce(p_display_name,'')),''), 'host');
  return v_room;
end; $$;

create or replace function public.bg_join(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room public.blak_group_rooms; v_count int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_room from public.blak_group_rooms where code = upper(trim(p_code)) and status = 'active' limit 1;
  if v_room.id is null then return null; end if;
  select count(*) into v_count from public.blak_group_members where room_id = v_room.id;
  if v_count >= 8 and not exists (select 1 from public.blak_group_members where room_id = v_room.id and user_id = auth.uid()) then
    raise exception 'room full';
  end if;
  insert into public.blak_group_members (room_id, user_id, display_name, role)
  values (v_room.id, auth.uid(), nullif(trim(coalesce(p_display_name,'')),''), 'member')
  on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return v_room.id;
end; $$;

create or replace function public.bg_end_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
begin update public.blak_group_rooms set status = 'ended', ended_at = now() where id = p_room and creator_id = auth.uid(); end; $$;

create or replace function public.bg_remove_member(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.blak_group_rooms r where r.id = p_room and r.creator_id = auth.uid()) then
    delete from public.blak_group_members where room_id = p_room and user_id = p_user and user_id <> auth.uid();
  end if;
end; $$;

grant execute on function public.bg_is_member(uuid)           to authenticated;
grant execute on function public.bg_create_room(text, text)   to authenticated;
grant execute on function public.bg_join(text, text)          to authenticated;
grant execute on function public.bg_end_room(uuid)            to authenticated;
grant execute on function public.bg_remove_member(uuid, uuid) to authenticated;

-- Realtime: stream messages + roster + room status to members (idempotent).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='blak_group_messages') then alter publication supabase_realtime add table public.blak_group_messages; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='blak_group_members') then alter publication supabase_realtime add table public.blak_group_members; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='blak_group_rooms') then alter publication supabase_realtime add table public.blak_group_rooms; end if;
end $$;
