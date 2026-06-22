-- Nexus — soft-hide lifecycle: notify the author (NEXUS-GAPS.md Phase 1, #11).
-- When content is soft-hidden by a MODERATOR/ADMIN/BAN (an UPDATE false→true), the
-- author gets a private notice. Crisis hides happen at INSERT, so they're excluded
-- here (they have their own support card, #5). The admin queue (#7) is the review path.

begin;

create table if not exists public.nexus_content_notices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  post_id         uuid references public.nexus_posts(id) on delete cascade,
  comment_id      uuid references public.nexus_comments(id) on delete cascade,
  reason          text not null default 'removed_by_moderator',
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_nexus_notices_open
  on public.nexus_content_notices (user_id, created_at desc) where acknowledged_at is null;
alter table public.nexus_content_notices enable row level security;
drop policy if exists nexus_notices_owner_read on public.nexus_content_notices;
create policy nexus_notices_owner_read on public.nexus_content_notices
  for select using (auth.uid() = user_id);
drop policy if exists nexus_notices_owner_ack on public.nexus_content_notices;
create policy nexus_notices_owner_ack on public.nexus_content_notices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, update on public.nexus_content_notices to authenticated;

create or replace function public._nexus_post_removed_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.is_soft_hidden = false and new.is_soft_hidden = true and new.is_ai_author is not true then
    insert into public.nexus_content_notices (user_id, post_id) values (new.author_user_id, new.id);
  end if;
  return null;
exception when others then return null;
end;
$$;
drop trigger if exists trg_nexus_post_removed_notice on public.nexus_posts;
create trigger trg_nexus_post_removed_notice
  after update of is_soft_hidden on public.nexus_posts
  for each row execute function public._nexus_post_removed_notice();

create or replace function public._nexus_comment_removed_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.is_soft_hidden = false and new.is_soft_hidden = true and new.is_ai_author is not true then
    insert into public.nexus_content_notices (user_id, comment_id) values (new.author_user_id, new.id);
  end if;
  return null;
exception when others then return null;
end;
$$;
drop trigger if exists trg_nexus_comment_removed_notice on public.nexus_comments;
create trigger trg_nexus_comment_removed_notice
  after update of is_soft_hidden on public.nexus_comments
  for each row execute function public._nexus_comment_removed_notice();

commit;
