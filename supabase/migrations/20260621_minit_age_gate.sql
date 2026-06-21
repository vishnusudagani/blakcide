-- Phase 3 (two-sided safety): 18+ age-gate folded into the matcher. Blocks a NEW
-- session when we know the seeker is under 18 (DOB or stored age). The client
-- captures DOB first when it's unknown, so this is defense-in-depth.
-- Full body reproduced verbatim from the live function with only the age guard added.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)

create or replace function public.minit_start_session(preferred uuid default null, is_anon boolean default true, p_intake jsonb default null)
returns table(session_id uuid, listener_id uuid, outcome text, used_preferred boolean)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  fresh constant interval := interval '120 seconds';
  v_id uuid; v_lid uuid; v_status text; v_outcome text;
  chosen uuid; chosen_outcome text;
  attempts int := 0;
  v_today numeric; v_week numeric;
  v_age int; v_dob date;
  pref_lang text := nullif(p_intake->>'language', '');
  pref_gender text := nullif(p_intake->>'gender', '');
  pref_topics text[] := case when p_intake ? 'topics'
                             then array(select jsonb_array_elements_text(p_intake->'topics')) end;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if public.minit_is_banned(uid) then
    return query select null::uuid, null::uuid, 'banned'::text, false; return;
  end if;

  -- Age gate (18+). Block if we know they're under 18; the client captures DOB first when unknown.
  select age, dob into v_age, v_dob from public.user_profiles where id = uid;
  if (v_dob is not null and v_dob > current_date - interval '18 years')
     or (v_dob is null and v_age is not null and v_age < 18) then
    return query select null::uuid, null::uuid, 'underage'::text, false; return;
  end if;

  -- Resume an already-open/queued session if one exists (never blocked by budget).
  select s.id, s.listener_id, s.status into v_id, v_lid, v_status
  from public.connect_sessions s
  where s.user_id = uid and s.status in ('pending', 'active')
  order by s.created_at desc limit 1;
  if found then
    if v_status = 'active' then v_outcome := 'open';
    elsif exists (select 1 from public.connect_sessions a where a.listener_id = v_lid and a.status = 'active')
      then v_outcome := 'queued';
    else v_outcome := 'open'; end if;
    return query select v_id, v_lid, v_outcome, false; return;
  end if;

  select today_min, week_min into v_today, v_week from public.minit_minutes_used();
  if coalesce(v_today, 0) >= 10 or coalesce(v_week, 0) >= 30 then
    return query select null::uuid, null::uuid, 'capped'::text, false; return;
  end if;

  loop
    attempts := attempts + 1;
    exit when attempts > 8;
    chosen := null; chosen_outcome := null;

    if preferred is not null then
      select l.id into chosen from public.listeners l
      where l.id = preferred and l.is_online
        and (l.last_seen is null or l.last_seen > now() - fresh)
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
      limit 1;
      if found then chosen_outcome := 'open';
      else
        select l.id into chosen from public.listeners l
        where l.id = preferred and l.is_online
          and (l.last_seen is null or l.last_seen > now() - fresh)
          and exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
          and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
        limit 1;
        if found then chosen_outcome := 'queued'; end if;
      end if;
      if chosen is null then
        return query select null::uuid, null::uuid, 'preferred_unavailable'::text, false; return;
      end if;
    else
      select l.id into chosen from public.listeners l
      where l.is_online and (l.last_seen is null or l.last_seen > now() - fresh)
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
      order by (
        (case when pref_lang is not null and l.languages @> array[pref_lang] then 3 else 0 end)
      + (case when pref_topics is not null and l.specialties && pref_topics then 2 else 0 end)
      + (case when pref_gender is not null and l.gender = pref_gender then 1 else 0 end)
      ) desc, random() limit 1;
      if found then chosen_outcome := 'open'; end if;

      if chosen is null then
        select l.id into chosen from public.listeners l
        where l.is_online and (l.last_seen is null or l.last_seen > now() - fresh)
          and exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
          and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
        order by (
          (case when pref_lang is not null and l.languages @> array[pref_lang] then 3 else 0 end)
        + (case when pref_topics is not null and l.specialties && pref_topics then 2 else 0 end)
        + (case when pref_gender is not null and l.gender = pref_gender then 1 else 0 end)
        ) desc, random() limit 1;
        if found then chosen_outcome := 'queued'; end if;
      end if;

      if chosen is null then
        if exists (select 1 from public.listeners l where l.is_online
                   and (l.last_seen is null or l.last_seen > now() - fresh))
          then return query select null::uuid, null::uuid, 'busy_full'::text, false;
          else return query select null::uuid, null::uuid, 'none'::text, false; end if;
        return;
      end if;
    end if;

    begin
      insert into public.connect_sessions (user_id, listener_id, session_type, is_anonymous, status, intake)
      values (uid, chosen, 'chat', coalesce(is_anon, true), 'pending', p_intake)
      returning id into v_id;
    exception when unique_violation then
      continue;
    end;

    return query select v_id, chosen, chosen_outcome, (preferred is not null);
    return;
  end loop;

  return query select null::uuid, null::uuid, 'busy_full'::text, false;
end;
$function$;
