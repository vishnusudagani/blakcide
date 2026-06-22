-- Nexus — in-app notifications (NEXUS-GAPS.md Phase 3, #29). Best-effort AFTER-INSERT
-- triggers that drop a row into the existing `notifications` inbox (AppLayout already
-- shows + realtime-subscribes to it). Generic bodies (no actor identity leaked).
-- Push + email delivery need infra (FCM/APNs, email) — documented, not built here.
-- "Tribe you're in goes live" waits on rooms↔tribe link (Phase 4 #39).
begin;

create or replace function public._nexus_notify_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_author uuid;
begin
  if new.is_ai_author is true then return null; end if;
  select author_user_id into v_author from public.nexus_posts where id = new.post_id;
  if v_author is not null and v_author <> new.author_user_id then
    insert into public.notifications (user_id, kind, title, body, url)
    values (v_author, 'nexus_reply', 'New reply on your post', left(coalesce(new.body, ''), 90), '/beta/nexus/');
  end if;
  return null;
exception when others then return null;
end;
$$;
drop trigger if exists trg_nexus_notify_reply on public.nexus_comments;
create trigger trg_nexus_notify_reply after insert on public.nexus_comments
  for each row execute function public._nexus_notify_reply();

create or replace function public._nexus_notify_resonance() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_author uuid;
begin
  if new.post_id is not null and new.impact_type = 'resonated' then
    select author_user_id into v_author from public.nexus_posts where id = new.post_id;
    if v_author is not null and v_author <> new.user_id then
      insert into public.notifications (user_id, kind, title, body, url)
      values (v_author, 'nexus_resonance', 'Someone resonated with your post', 'Your words struck a chord.', '/beta/nexus/');
    end if;
  end if;
  return null;
exception when others then return null;
end;
$$;
drop trigger if exists trg_nexus_notify_resonance on public.nexus_impacts;
create trigger trg_nexus_notify_resonance after insert on public.nexus_impacts
  for each row execute function public._nexus_notify_resonance();

create or replace function public._nexus_notify_dm() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, kind, title, body, url)
  values (new.recipient_user_id, 'nexus_dm', 'New private message', 'You have a new anonymous message in Nexus.', '/beta/nexus/');
  return null;
exception when others then return null;
end;
$$;
drop trigger if exists trg_nexus_notify_dm on public.nexus_dm_messages;
create trigger trg_nexus_notify_dm after insert on public.nexus_dm_messages
  for each row execute function public._nexus_notify_dm();

commit;
