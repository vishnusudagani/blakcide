-- Minit — Phase 3a: Smart Match (connect mode L2).
--
-- The seeker tells us a little (language, what's on their mind, optional gender
-- preference); the matcher scores free/queueable listeners by how well they fit
-- and prefers the best — while still always connecting someone (graceful fallback
-- to Instant behaviour when nothing matches or no intake is given). What they
-- told us is stored on the session as `intake` — context for the listener now,
-- and fuel for the Blak co-pilot brief later.

-- ── richer listener profiles (also powers Listener Discovery) ───────────────
alter table public.listeners add column if not exists specialties text[];  -- topics they're comfortable with
alter table public.listeners add column if not exists gender text;         -- optional, for preference matching
alter table public.listeners add column if not exists style text;          -- short "listening style" blurb

-- what the seeker told us at the start (mood / topics / language / prefs)
alter table public.connect_sessions add column if not exists intake jsonb;

-- refresh the safe public view with the discovery fields. drop+create (not
-- CREATE OR REPLACE): the column order changes vs the Phase-1 view, which
-- CREATE OR REPLACE VIEW disallows.
drop view if exists public.listeners_public;
create view public.listeners_public as
  select id, display_name, profile_pic, bio, style, languages, specialties, gender,
         rating, reviews_count, chat_price_per_min, call_price_per_min, is_online, last_seen
  from public.listeners;
grant select on public.listeners_public to authenticated;

-- ── matcher: now intake-aware ───────────────────────────────────────────────
-- Replaces the 2-arg version. p_intake (jsonb) is optional; when absent the
-- scoring collapses to 0 and behaviour is identical to Instant Match.
drop function if exists public.minit_start_session(uuid, boolean);
create or replace function public.minit_start_session(
  preferred uuid default null, is_anon boolean default true, p_intake jsonb default null)
returns table (session_id uuid, listener_id uuid, outcome text, used_preferred boolean)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  fresh constant interval := interval '120 seconds';
  v_id uuid; v_lid uuid; v_status text; v_outcome text;
  chosen uuid; chosen_outcome text;
  attempts int := 0;
  pref_lang text := nullif(p_intake->>'language', '');
  pref_gender text := nullif(p_intake->>'gender', '');
  pref_topics text[] := case when p_intake ? 'topics'
                             then array(select jsonb_array_elements_text(p_intake->'topics')) end;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  -- Idempotency: return any in-flight session instead of creating a duplicate.
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
      -- idle listeners, best fit first (language 3 · topic-overlap 2 · gender 1), random tiebreak
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
$$;
grant execute on function public.minit_start_session(uuid, boolean, jsonb) to authenticated;

-- ── provisioning: set the new profile fields too ────────────────────────────
drop function if exists public.admin_provision_listener(text, text, text[], text);
create or replace function public.admin_provision_listener(
  p_email text, p_display_name text default null, p_languages text[] default null,
  p_bio text default null, p_specialties text[] default null, p_gender text default null, p_style text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select id into v_uid from auth.users where lower(email) = lower(p_email) limit 1;
  if v_uid is null then raise exception 'no user with email %', p_email; end if;

  select id into v_id from public.listeners where user_id = v_uid;
  if v_id is null then
    insert into public.listeners (user_id, display_name, languages, bio, specialties, gender, style, is_online)
    values (v_uid, coalesce(p_display_name, split_part(p_email, '@', 1)), p_languages, p_bio, p_specialties, p_gender, p_style, false)
    returning id into v_id;
  else
    update public.listeners set
      display_name = coalesce(p_display_name, display_name),
      languages    = coalesce(p_languages, languages),
      bio          = coalesce(p_bio, bio),
      specialties  = coalesce(p_specialties, specialties),
      gender       = coalesce(p_gender, gender),
      style        = coalesce(p_style, style)
      where id = v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function public.admin_provision_listener(text, text, text[], text, text[], text, text) to authenticated;
