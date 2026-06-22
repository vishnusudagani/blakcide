-- Nexus — recognition layer: streaks + badges (NEXUS-GAPS.md Phase 2, #18/#19).
-- Read-only compute RPCs over existing activity — no new tables, no engagement-bait.
-- Streaks are GENTLE (presence, not pressure): we surface current + longest, never
-- punish a break. Badges are earned milestones / contribution / presence.

begin;

-- ── #18 Streaks: consecutive days with any contribution (post/comment/resonate) ─
create or replace function public.nexus_my_streak()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_cur int := 0; v_long int := 0; v_run int := 0;
  v_active boolean := false;
  prev date := null; r record;
begin
  if v_uid is null then return jsonb_build_object('current', 0, 'longest', 0, 'active_today', false); end if;

  for r in
    select distinct (created_at at time zone 'utc')::date as d from (
      select created_at from public.nexus_posts    where author_user_id = v_uid
      union all select created_at from public.nexus_comments where author_user_id = v_uid
      union all select created_at from public.nexus_impacts  where user_id = v_uid
    ) c order by d
  loop
    if prev is not null and r.d = prev + 1 then v_run := v_run + 1; else v_run := 1; end if;
    if v_run > v_long then v_long := v_run; end if;
    if r.d = v_today then v_active := true; end if;
    prev := r.d;
  end loop;

  prev := null;
  for r in
    select distinct (created_at at time zone 'utc')::date as d from (
      select created_at from public.nexus_posts    where author_user_id = v_uid
      union all select created_at from public.nexus_comments where author_user_id = v_uid
      union all select created_at from public.nexus_impacts  where user_id = v_uid
    ) c order by d desc
  loop
    if prev is null then
      if r.d = v_today or r.d = v_today - 1 then v_cur := 1; prev := r.d; else exit; end if;
    elsif r.d = prev - 1 then v_cur := v_cur + 1; prev := r.d; else exit; end if;
  end loop;

  return jsonb_build_object('current', v_cur, 'longest', greatest(v_long, v_cur), 'active_today', v_active);
end;
$$;
grant execute on function public.nexus_my_streak() to authenticated;

-- ── #19 Badges: earned milestones / contribution / presence ─────────────────
create or replace function public.nexus_my_badges()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_posts int; v_comments int; v_resonates int; v_tribes int; v_founder boolean; v_streak int;
  v_out jsonb := '[]'::jsonb;
begin
  if v_uid is null then return v_out; end if;
  select count(*) into v_posts    from public.nexus_posts    where author_user_id = v_uid;
  select count(*) into v_comments from public.nexus_comments where author_user_id = v_uid;
  select coalesce(sum(impact_count), 0) into v_resonates from public.nexus_posts where author_user_id = v_uid;
  select count(*) into v_tribes   from public.nexus_community_members where user_id = v_uid;
  select exists(select 1 from public.nexus_community_members where user_id = v_uid and role = 'moderator') into v_founder;
  select (public.nexus_my_streak() ->> 'current')::int into v_streak;

  if v_posts >= 1     then v_out := v_out || jsonb_build_object('key','first_voice','label','First Voice','emoji','🌱','family','milestone'); end if;
  if v_posts >= 10    then v_out := v_out || jsonb_build_object('key','storyteller','label','Storyteller','emoji','📖','family','milestone'); end if;
  if v_founder        then v_out := v_out || jsonb_build_object('key','founder','label','Tribe Founder','emoji','🪧','family','milestone'); end if;
  if v_comments >= 25 then v_out := v_out || jsonb_build_object('key','in_the_room','label','In the Room','emoji','💬','family','presence'); end if;
  if v_tribes >= 3    then v_out := v_out || jsonb_build_object('key','explorer','label','Explorer','emoji','🧭','family','presence'); end if;
  if v_streak >= 7    then v_out := v_out || jsonb_build_object('key','steady','label','Steady Presence','emoji','🕯️','family','presence'); end if;
  if v_resonates >= 25  then v_out := v_out || jsonb_build_object('key','resonant','label','Resonant','emoji','◈','family','contribution'); end if;
  if v_resonates >= 100 then v_out := v_out || jsonb_build_object('key','deeply_felt','label','Deeply Felt','emoji','💫','family','contribution'); end if;

  return v_out;
end;
$$;
grant execute on function public.nexus_my_badges() to authenticated;

commit;
