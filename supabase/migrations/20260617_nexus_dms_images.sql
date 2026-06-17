-- Nexus — tribe-scoped anonymous DMs + image sharing.
--
-- Anonymity: the browser only ever shows per-tribe pseudonymous handles. DMs route
-- by user_id (plumbing, never displayed); neither party sees the other's name/email.
-- DMs are allowed only between two MEMBERS of the same tribe.

-- Images on discussions + replies.
alter table public.nexus_posts    add column if not exists image_url text;
alter table public.nexus_comments add column if not exists image_url text;

-- Membership check that bypasses RLS (nexus_community_members is self-read-only, so
-- a DM-send policy can't see the recipient's membership without this helper).
create or replace function public.nexus_is_member(p_comm uuid, p_user uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.nexus_community_members where community_id = p_comm and user_id = p_user);
$$;
grant execute on function public.nexus_is_member(uuid, uuid) to authenticated, anon;

create table if not exists public.nexus_dm_messages (
  id                uuid primary key default gen_random_uuid(),
  community_id      uuid not null references public.nexus_communities(id) on delete cascade,
  sender_user_id    uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  body              text,
  image_url         text,
  created_at        timestamptz not null default now(),
  constraint nexus_dm_has_content check (body is not null or image_url is not null),
  constraint nexus_dm_distinct    check (sender_user_id <> recipient_user_id)
);
create index if not exists idx_nexus_dm_pair on public.nexus_dm_messages (community_id, sender_user_id, recipient_user_id, created_at);
create index if not exists idx_nexus_dm_recipient on public.nexus_dm_messages (recipient_user_id, created_at desc);
alter table public.nexus_dm_messages enable row level security;

-- Read: only the two participants.
drop policy if exists nexus_dm_read on public.nexus_dm_messages;
create policy nexus_dm_read on public.nexus_dm_messages for select
  using (auth.uid() = sender_user_id or auth.uid() = recipient_user_id);

-- Send: I am the sender, and BOTH of us are members of the tribe.
drop policy if exists nexus_dm_send on public.nexus_dm_messages;
create policy nexus_dm_send on public.nexus_dm_messages for insert
  with check (
    auth.uid() = sender_user_id
    and public.nexus_is_member(community_id, sender_user_id)
    and public.nexus_is_member(community_id, recipient_user_id)
  );

grant select, insert on public.nexus_dm_messages to authenticated;
alter publication supabase_realtime add table public.nexus_dm_messages;

-- Storage: public-read bucket for shared images; authenticated upload.
insert into storage.buckets (id, name, public) values ('nexus-img', 'nexus-img', true) on conflict (id) do nothing;
drop policy if exists nexus_img_read on storage.objects;
create policy nexus_img_read on storage.objects for select using (bucket_id = 'nexus-img');
drop policy if exists nexus_img_insert on storage.objects;
create policy nexus_img_insert on storage.objects for insert to authenticated with check (bucket_id = 'nexus-img');
