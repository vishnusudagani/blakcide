-- Nexus — posting rate limits / anti-spam (NEXUS-GAPS.md Phase 1, #8).
--
-- BEFORE INSERT triggers (fire in BOTH legacy + proxy paths) that reject a write
-- when an author exceeds a generous rolling-window cap. Caps are anti-spam, not
-- anti-use — a normal human never hits them. Blak (is_ai_author) is exempt; it has
-- its own engine-side caps. Raising aborts only the offending insert.

begin;

create or replace function public._nexus_rl_posts() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.is_ai_author is true then return new; end if;
  select count(*) into n from public.nexus_posts
    where author_user_id = new.author_user_id and created_at > now() - interval '5 minutes';
  if n >= 8 then
    raise exception 'rate_limit'
      using message = 'You''re posting very fast — take a breather and try again in a minute.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_nexus_rl_posts on public.nexus_posts;
create trigger trg_nexus_rl_posts before insert on public.nexus_posts
  for each row execute function public._nexus_rl_posts();

create or replace function public._nexus_rl_comments() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.is_ai_author is true then return new; end if;
  select count(*) into n from public.nexus_comments
    where author_user_id = new.author_user_id and created_at > now() - interval '5 minutes';
  if n >= 30 then
    raise exception 'rate_limit'
      using message = 'You''re replying very fast — give it a moment and try again.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_nexus_rl_comments on public.nexus_comments;
create trigger trg_nexus_rl_comments before insert on public.nexus_comments
  for each row execute function public._nexus_rl_comments();

create or replace function public._nexus_rl_dms() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from public.nexus_dm_messages
    where sender_user_id = new.sender_user_id and created_at > now() - interval '5 minutes';
  if n >= 40 then
    raise exception 'rate_limit'
      using message = 'You''re sending messages very fast — take a short break.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_nexus_rl_dms on public.nexus_dm_messages;
create trigger trg_nexus_rl_dms before insert on public.nexus_dm_messages
  for each row execute function public._nexus_rl_dms();

commit;
