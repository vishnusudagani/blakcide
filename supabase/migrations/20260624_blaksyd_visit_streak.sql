-- Blaksyd — visit streaks: an overall "days you showed up" streak plus per-pillar
-- (Blak / Minit / Nexus) sub-streaks, surfaced as a flame in the Blak home header.
-- STRICT (user's choice): a fully missed day resets the streak to 0 — no freeze /
-- grace days. The day boundary is IST (Asia/Kolkata) so "today" matches the user's
-- own calendar. Visits are recorded via blaksyd_log_visit() (one idempotent row per
-- user/day/pillar); streaks are read-only compute over that table. Presence, not
-- pressure — no engagement-bait, mirrors the gentle nexus_my_streak() shape.

begin;

create table if not exists public.blaksyd_visits (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  pillar     text not null check (pillar in ('app','blak','minit','nexus')),
  created_at timestamptz not null default now(),
  primary key (user_id, day, pillar)
);
create index if not exists blaksyd_visits_user_day_idx on public.blaksyd_visits (user_id, day desc);

alter table public.blaksyd_visits enable row level security;
-- Read-your-own only; every write goes through the security-definer RPC below.
drop policy if exists blaksyd_visits_select_own on public.blaksyd_visits;
create policy blaksyd_visits_select_own on public.blaksyd_visits
  for select using (user_id = auth.uid());

-- ── current consecutive-day streak for one pillar (null = overall / any visit) ──
-- "Alive" while the last visit was today OR yesterday (the day isn't over yet); a
-- gap of a full day breaks it — that's the strict reset.
create or replace function public._blaksyd_streak_cur(p_uid uuid, p_pillar text)
returns int language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_cur int := 0; prev date := null; r record;
begin
  for r in
    select distinct day as d from public.blaksyd_visits
    where user_id = p_uid and (p_pillar is null or pillar = p_pillar)
    order by day desc
  loop
    if prev is null then
      if r.d = v_today or r.d = v_today - 1 then v_cur := 1; prev := r.d; else exit; end if;
    elsif r.d = prev - 1 then v_cur := v_cur + 1; prev := r.d; else exit; end if;
  end loop;
  return v_cur;
end; $$;
revoke all on function public._blaksyd_streak_cur(uuid, text) from public;

-- ── longest-ever overall streak (any-visit days) ──
create or replace function public._blaksyd_streak_long(p_uid uuid)
returns int language plpgsql stable security definer set search_path = public as $$
declare v_long int := 0; v_run int := 0; prev date := null; r record;
begin
  for r in select distinct day as d from public.blaksyd_visits where user_id = p_uid order by day asc
  loop
    if prev is not null and r.d = prev + 1 then v_run := v_run + 1; else v_run := 1; end if;
    if v_run > v_long then v_long := v_run; end if;
    prev := r.d;
  end loop;
  return v_long;
end; $$;
revoke all on function public._blaksyd_streak_long(uuid) from public;

-- ── read the caller's streaks ──
create or replace function public.blaksyd_my_streak()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_overall int; v_long int;
begin
  if v_uid is null then
    return jsonb_build_object('overall',0,'longest',0,'blak',0,'minit',0,'nexus',0,'active_today',false);
  end if;
  v_overall := public._blaksyd_streak_cur(v_uid, null);
  v_long    := public._blaksyd_streak_long(v_uid);
  return jsonb_build_object(
    'overall',      v_overall,
    'longest',      greatest(v_long, v_overall),
    'blak',         public._blaksyd_streak_cur(v_uid, 'blak'),
    'minit',        public._blaksyd_streak_cur(v_uid, 'minit'),
    'nexus',        public._blaksyd_streak_cur(v_uid, 'nexus'),
    'active_today', exists(select 1 from public.blaksyd_visits where user_id = v_uid and day = v_today)
  );
end; $$;
grant execute on function public.blaksyd_my_streak() to authenticated;
revoke execute on function public.blaksyd_my_streak() from public;

-- ── record today's visit (idempotent) and return the fresh streaks ──
-- Every visit logs the 'app' row (overall streak). Pillar pages additionally log
-- their pillar so the sub-streak counts "days you used that feature".
create or replace function public.blaksyd_log_visit(p_pillar text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_uid is null then
    return jsonb_build_object('overall',0,'longest',0,'blak',0,'minit',0,'nexus',0,'active_today',false);
  end if;
  if p_pillar is not null and p_pillar not in ('blak','minit','nexus') then p_pillar := null; end if;
  insert into public.blaksyd_visits(user_id, day, pillar) values (v_uid, v_today, 'app')
    on conflict (user_id, day, pillar) do nothing;
  if p_pillar is not null then
    insert into public.blaksyd_visits(user_id, day, pillar) values (v_uid, v_today, p_pillar)
      on conflict (user_id, day, pillar) do nothing;
  end if;
  return public.blaksyd_my_streak();
end; $$;
grant execute on function public.blaksyd_log_visit(text) to authenticated;
revoke execute on function public.blaksyd_log_visit(text) from public;

commit;
