-- Minit — Phase 4a: moderation & admin (two-sided safety enforcement).
--
-- "Blaksyd does not operate under 'the user is always right'." This adds the
-- enforcement backbone: a ban list checked at match time, plus admin-only RPCs
-- powering the /beta/admin T&S console (flag triage, ban/unban, provisioning).

-- ── ban list ────────────────────────────────────────────────────────────────
create table if not exists public.minit_bans (
  user_id uuid primary key,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  expires_at timestamptz                  -- null = permanent
);
alter table public.minit_bans enable row level security;
drop policy if exists mb_admin_all on public.minit_bans;
create policy mb_admin_all on public.minit_bans for all using (is_admin()) with check (is_admin());

create or replace function public.minit_is_banned(p_uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.minit_bans b
                 where b.user_id = p_uid and (b.expires_at is null or b.expires_at > now()));
$$;

-- ── match: now refuses a banned user (returns 'banned') ─────────────────────
-- Re-creates the Smart-Match version with a ban gate at the top; everything else
-- is unchanged.
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
  if public.minit_is_banned(uid) then
    return query select null::uuid, null::uuid, 'banned'::text, false; return;
  end if;

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

-- ── admin RPCs (is_admin-gated) ─────────────────────────────────────────────
create or replace function public.minit_admin_ban(p_user_id uuid, p_reason text default null, p_days integer default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into public.minit_bans (user_id, reason, created_by, expires_at)
  values (p_user_id, p_reason, auth.uid(),
          case when p_days is null then null else now() + make_interval(days => p_days) end)
  on conflict (user_id) do update
    set reason = excluded.reason, created_by = excluded.created_by,
        created_at = now(), expires_at = excluded.expires_at;
  -- pull any in-flight session for that user
  update public.connect_sessions set status = 'cancelled'
    where user_id = p_user_id and status in ('pending', 'active');
end;
$$;

create or replace function public.minit_admin_unban(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from public.minit_bans where user_id = p_user_id;
end;
$$;

-- One call powering the console: flagged sessions, bans, listeners, headline stats.
create or replace function public.minit_admin_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return jsonb_build_object(
    'flagged', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', id, 'user_id', user_id, 'listener_id', listener_id,
                  'flag_reason', flag_reason, 'flagged_at', flagged_at, 'status', status,
                  'banned', public.minit_is_banned(user_id)) order by flagged_at desc), '[]'::jsonb)
                from public.connect_sessions where flagged_at is not null),
    'bans', (select coalesce(jsonb_agg(jsonb_build_object(
               'user_id', user_id, 'reason', reason, 'created_at', created_at, 'expires_at', expires_at)
               order by created_at desc), '[]'::jsonb) from public.minit_bans),
    'listeners', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', id, 'display_name', display_name, 'is_online', is_online,
                    'rating', rating, 'reviews_count', reviews_count) order by display_name), '[]'::jsonb)
                  from public.listeners),
    'stats', (select jsonb_build_object(
                'completed', count(*) filter (where status = 'completed'),
                'active', count(*) filter (where status = 'active'),
                'flagged', count(*) filter (where flagged_at is not null))
              from public.connect_sessions)
  );
end;
$$;

grant execute on function public.minit_is_banned(uuid) to authenticated;
grant execute on function public.minit_admin_ban(uuid, text, integer) to authenticated;
grant execute on function public.minit_admin_unban(uuid) to authenticated;
grant execute on function public.minit_admin_overview() to authenticated;
revoke execute on function public.minit_is_banned(uuid) from public;
revoke execute on function public.minit_admin_ban(uuid, text, integer) from public;
revoke execute on function public.minit_admin_unban(uuid) from public;
revoke execute on function public.minit_admin_overview() from public;
