-- Team OS — Postgres triggers for audit log + notifications.
-- Runs after the Phase 2 schema migration. Adds:
--   • teamos_audit_record() trigger fn — writes one audit_log row per INSERT/UPDATE/DELETE
--   • teamos_notify_assignment() — notifies new assignee when a task is (re)assigned
--   • teamos_notify_event_invite() — notifies attendees added to an event
--   • teamos_notify_mention() — comment/discussion mentions trigger notifications
--   • Realtime publication for comments, attachments, time entries, audit, daily updates

-- ─── 1. AUDIT LOG TRIGGER FUNCTION ────────────────────────────────────────
create or replace function public.teamos_audit_record()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_kind  text := substring(TG_TABLE_NAME from '^teamos_(.+)$');  -- e.g. teamos_tasks -> tasks
  v_id    bigint;
  v_summary text;
begin
  -- Don't audit the audit log itself
  if TG_TABLE_NAME = 'teamos_audit_log' then return null; end if;
  -- Skip when there's no authenticated actor (e.g. service_role admin scripts)
  if v_actor is null then
    if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
  end if;

  if TG_OP = 'INSERT' then
    v_id := (row_to_json(NEW) ->> 'id')::bigint;
    v_summary := case
      when TG_TABLE_NAME = 'teamos_tasks'      then 'Created task: '      || coalesce(NEW.title, '')
      when TG_TABLE_NAME = 'teamos_roadmaps'   then 'Created roadmap: '   || coalesce(NEW.name, '')
      when TG_TABLE_NAME = 'teamos_goals'      then 'Created goal: '      || coalesce(NEW.title, '')
      when TG_TABLE_NAME = 'teamos_events'     then 'Scheduled event: '   || coalesce(NEW.title, '')
      when TG_TABLE_NAME = 'teamos_milestones' then 'Added milestone: '   || coalesce(NEW.title, '')
      when TG_TABLE_NAME = 'teamos_comments'   then 'Commented on task #' || NEW.task_id
      else 'Created ' || v_kind
    end;
    insert into public.teamos_audit_log (actor_id, action, ref_kind, ref_id, summary, payload)
    values (v_actor, 'create', v_kind, v_id, v_summary, null);
    return NEW;
  elsif TG_OP = 'UPDATE' then
    v_id := (row_to_json(NEW) ->> 'id')::bigint;
    -- Status changes get their own action label so timelines can highlight them
    if TG_TABLE_NAME = 'teamos_tasks' and OLD.status is distinct from NEW.status then
      v_summary := coalesce(NEW.title, 'task') || ': ' || OLD.status || ' → ' || NEW.status;
      insert into public.teamos_audit_log (actor_id, action, ref_kind, ref_id, summary, payload)
      values (v_actor, 'status_change', v_kind, v_id, v_summary,
              jsonb_build_object('from', OLD.status, 'to', NEW.status));
    else
      v_summary := case
        when TG_TABLE_NAME = 'teamos_tasks'    then 'Updated task: '    || coalesce(NEW.title, '')
        when TG_TABLE_NAME = 'teamos_roadmaps' then 'Updated roadmap: ' || coalesce(NEW.name, '')
        when TG_TABLE_NAME = 'teamos_goals'    then 'Updated goal: '    || coalesce(NEW.title, '')
        when TG_TABLE_NAME = 'teamos_events'   then 'Edited event: '    || coalesce(NEW.title, '')
        else 'Updated ' || v_kind
      end;
      insert into public.teamos_audit_log (actor_id, action, ref_kind, ref_id, summary, payload)
      values (v_actor, 'update', v_kind, v_id, v_summary, null);
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    v_id := (row_to_json(OLD) ->> 'id')::bigint;
    v_summary := case
      when TG_TABLE_NAME = 'teamos_tasks'    then 'Deleted task: '    || coalesce(OLD.title, '')
      when TG_TABLE_NAME = 'teamos_roadmaps' then 'Deleted roadmap: ' || coalesce(OLD.name, '')
      when TG_TABLE_NAME = 'teamos_goals'    then 'Deleted goal: '    || coalesce(OLD.title, '')
      when TG_TABLE_NAME = 'teamos_events'   then 'Deleted event: '   || coalesce(OLD.title, '')
      else 'Deleted ' || v_kind
    end;
    insert into public.teamos_audit_log (actor_id, action, ref_kind, ref_id, summary, payload)
    values (v_actor, 'delete', v_kind, v_id, v_summary, null);
    return OLD;
  end if;
  return null;
end;
$$;

-- Attach the audit trigger to the things that matter for an activity feed
drop trigger if exists teamos_audit_tasks      on public.teamos_tasks;
drop trigger if exists teamos_audit_roadmaps   on public.teamos_roadmaps;
drop trigger if exists teamos_audit_goals      on public.teamos_goals;
drop trigger if exists teamos_audit_events     on public.teamos_events;
drop trigger if exists teamos_audit_milestones on public.teamos_milestones;
drop trigger if exists teamos_audit_comments   on public.teamos_comments;

create trigger teamos_audit_tasks      after insert or update or delete on public.teamos_tasks      for each row execute function public.teamos_audit_record();
create trigger teamos_audit_roadmaps   after insert or update or delete on public.teamos_roadmaps   for each row execute function public.teamos_audit_record();
create trigger teamos_audit_goals      after insert or update or delete on public.teamos_goals      for each row execute function public.teamos_audit_record();
create trigger teamos_audit_events     after insert or update or delete on public.teamos_events     for each row execute function public.teamos_audit_record();
create trigger teamos_audit_milestones after insert or update or delete on public.teamos_milestones for each row execute function public.teamos_audit_record();
create trigger teamos_audit_comments   after insert                     on public.teamos_comments   for each row execute function public.teamos_audit_record();

-- ─── 2. NOTIFICATION — task assignment ────────────────────────────────────
create or replace function public.teamos_notify_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
begin
  -- Only fire when assignee actually changed AND someone is now assigned
  if (TG_OP = 'INSERT' and NEW.assigned_to is not null and NEW.assigned_to <> coalesce(v_actor, NEW.assigned_to))
     or (TG_OP = 'UPDATE' and NEW.assigned_to is distinct from OLD.assigned_to and NEW.assigned_to is not null and NEW.assigned_to <> coalesce(v_actor, NEW.assigned_to)) then
    select full_name into v_actor_name from public.teamos_profiles where id = v_actor;
    insert into public.teamos_notifications (user_id, type, message, ref_kind, ref_id, actor_id, read)
    values (NEW.assigned_to, 'task_assigned',
            coalesce(v_actor_name, 'Someone') || ' assigned you: ' || NEW.title,
            'task', NEW.id, v_actor, false);
  end if;
  return NEW;
end;
$$;

drop trigger if exists teamos_notify_task_assignment on public.teamos_tasks;
create trigger teamos_notify_task_assignment after insert or update of assigned_to on public.teamos_tasks
  for each row execute function public.teamos_notify_assignment();

-- ─── 3. NOTIFICATION — event invite ───────────────────────────────────────
create or replace function public.teamos_notify_event_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_attendee uuid;
  v_old_set uuid[];
  v_new_set uuid[];
  v_added uuid[];
begin
  if NEW.attendee_ids is null then return NEW; end if;
  v_new_set := NEW.attendee_ids;
  v_old_set := case when TG_OP = 'INSERT' then '{}'::uuid[] else coalesce(OLD.attendee_ids, '{}'::uuid[]) end;

  -- Find attendees added since last state (skip the actor themselves)
  v_added := array(select unnest(v_new_set) except select unnest(v_old_set));
  if array_length(v_added, 1) is null then return NEW; end if;

  select full_name into v_actor_name from public.teamos_profiles where id = v_actor;

  foreach v_attendee in array v_added loop
    if v_attendee is null or v_attendee = v_actor then continue; end if;
    insert into public.teamos_notifications (user_id, type, message, ref_kind, ref_id, actor_id, read)
    values (v_attendee, 'event_invite',
            coalesce(v_actor_name, 'Someone') || ' added you to "' || NEW.title || '"',
            'event', NEW.id, v_actor, false);
  end loop;
  return NEW;
end;
$$;

drop trigger if exists teamos_notify_event_invite_trig on public.teamos_events;
create trigger teamos_notify_event_invite_trig after insert or update of attendee_ids on public.teamos_events
  for each row execute function public.teamos_notify_event_invite();

-- ─── 4. NOTIFICATION — @mentions in comments + discussion ─────────────────
create or replace function public.teamos_notify_mentions()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_username text;
  v_target uuid;
  v_ref_kind text;
  v_ref_id bigint;
  v_surface text;
begin
  if v_actor is null or NEW.content is null then return NEW; end if;

  if TG_TABLE_NAME = 'teamos_comments' then
    v_ref_kind := 'task'; v_ref_id := NEW.task_id;
    v_surface := 'a comment';
  elsif TG_TABLE_NAME = 'teamos_discussion' then
    v_ref_kind := 'discussion'; v_ref_id := NEW.id;
    v_surface := 'team discussion';
  else
    return NEW;
  end if;

  select full_name into v_actor_name from public.teamos_profiles where id = v_actor;

  -- Pull out lowercase @usernames from the content. Case-insensitive match against profiles.
  for v_username in
    select distinct lower(m[1])
    from regexp_matches(lower(NEW.content), '(?<![a-z0-9_])@([a-z0-9_]{2,40})', 'g') as m
  loop
    select id into v_target from public.teamos_profiles where lower(username) = v_username limit 1;
    if v_target is null or v_target = v_actor then continue; end if;
    insert into public.teamos_notifications (user_id, type, message, ref_kind, ref_id, actor_id, read)
    values (v_target, 'mention',
            coalesce(v_actor_name, 'Someone') || ' mentioned you in ' || v_surface,
            v_ref_kind, v_ref_id, v_actor, false);
  end loop;
  return NEW;
end;
$$;

drop trigger if exists teamos_notify_mention_comments   on public.teamos_comments;
drop trigger if exists teamos_notify_mention_discussion on public.teamos_discussion;
create trigger teamos_notify_mention_comments   after insert on public.teamos_comments   for each row execute function public.teamos_notify_mentions();
create trigger teamos_notify_mention_discussion after insert on public.teamos_discussion for each row execute function public.teamos_notify_mentions();

-- ─── 5. Realtime publication — extend to more tables ──────────────────────
do $$ begin alter publication supabase_realtime add table public.teamos_audit_log; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.teamos_time_entries; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.teamos_attachments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.teamos_daily_updates; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.teamos_events; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.teamos_goals; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.teamos_roadmaps; exception when duplicate_object then null; end $$;
