-- India DPDP age gate — Blaksyd beta is 18+.
--
-- DPDP Act 2023 treats anyone under 18 as a child (verifiable parental consent +
-- no detrimental-to-wellbeing processing). For beta we restrict the product to
-- adults. This migration adds the server-authoritative pieces behind the app-wide
-- DOB gate (src/layouts/AppLayout.astro):
--   • is_adult(uid)   — reusable 18+ check, FAILS CLOSED (false when age unknown)
--   • age_status()    — 'adult' | 'minor' | 'unknown' for the calling user (gate read)
--   • set_my_dob(dob) — records the caller's DOB (server computes age), returns status
--   • minit_start_session — guard switched to is_adult() so unknown-age is BLOCKED
--     (previously only KNOWN under-18 was blocked; unknown-age could proceed).
--
-- Apply to prod with the Supabase MCP apply_migration; this file is the repo record.

-- ── Reusable 18+ check (fail closed) ────────────────────────────────────────
create or replace function public.is_adult(p_uid uuid)
returns boolean
language sql stable security definer set search_path = 'public'
as $$
  select coalesce((
    select case
      when up.dob is not null then up.dob <= current_date - interval '18 years'
      when up.age is not null then up.age >= 18
      else false                                  -- unknown age → not adult (deny)
    end
    from public.user_profiles up
    where up.id = p_uid
  ), false);
$$;

-- ── Age status for the calling user (drives the app-wide gate) ───────────────
create or replace function public.age_status()
returns text
language plpgsql stable security definer set search_path = 'public'
as $$
declare uid uuid := auth.uid(); v_dob date; v_age int;
begin
  if uid is null then return 'unknown'; end if;
  select dob, age into v_dob, v_age from public.user_profiles where id = uid;
  if v_dob is not null then
    return case when v_dob <= current_date - interval '18 years' then 'adult' else 'minor' end;
  elsif v_age is not null then
    return case when v_age >= 18 then 'adult' else 'minor' end;
  else
    return 'unknown';
  end if;
end;
$$;

-- ── Record the caller's DOB (server computes + stores age) ───────────────────
-- Upsert so it works whether or not a profile row exists yet. Validates the date.
create or replace function public.set_my_dob(p_dob date)
returns text
language plpgsql security definer set search_path = 'public'
as $$
declare uid uuid := auth.uid(); v_age int; v_adult boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_dob is null or p_dob > current_date or p_dob < current_date - interval '120 years' then
    raise exception 'invalid date of birth';
  end if;
  v_age := floor(extract(year from age(current_date, p_dob)))::int;
  v_adult := p_dob <= current_date - interval '18 years';
  -- Update-first, insert-only-if-absent. A plain UPDATE touches only dob/age, so it
  -- never trips a NOT NULL on some other profile column (which an INSERT ... ON CONFLICT
  -- would still evaluate on its candidate row). The row almost always exists already.
  update public.user_profiles set dob = p_dob, age = v_age where id = uid;
  if not found then
    insert into public.user_profiles (id, dob, age) values (uid, p_dob, v_age);
  end if;
  return case when v_adult then 'adult' else 'minor' end;
end;
$$;

grant execute on function public.is_adult(uuid)  to authenticated;
grant execute on function public.age_status()    to authenticated;
grant execute on function public.set_my_dob(date) to authenticated;

-- ── Minit matcher: 18+ guard switched to fail-closed is_adult() ─────────────
-- Body reproduced verbatim from 20260621_minit_age_gate.sql with ONLY the age
-- guard changed (now also blocks unknown-age).
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
  pref_lang text := nullif(p_intake->>'language', '');
  pref_gender text := nullif(p_intake->>'gender', '');
  pref_topics text[] := case when p_intake ? 'topics'
                             then array(select jsonb_array_elements_text(p_intake->'topics')) end;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if public.minit_is_banned(uid) then
    return query select null::uuid, null::uuid, 'banned'::text, false; return;
  end if;

  -- Age gate (18+), FAIL CLOSED. Blocks under-18 AND unknown-age. The app-wide DOB
  -- gate (AppLayout) records DOB before any feature is reachable, so a missing DOB
  -- here means the client gate was bypassed — deny rather than allow.
  if not public.is_adult(uid) then
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
