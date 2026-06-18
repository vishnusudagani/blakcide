-- Minit — queue-aware matching.
--
-- Model: one ACTIVE chat per listener, plus a single "next in line" PENDING
-- slot per listener (cap = 1 waiting). Selection moves server-side so it can
-- see who is busy (RLS hides other people's sessions from the seeker's browser,
-- so the old client-side "pick the first online listener" could neither balance
-- load nor avoid a listener who was mid-chat).
--
--   • free listener (online, fresh, no active, no pending)  → connect now ('open')
--   • busy listener with an empty waiting slot               → 'queued' (next in line)
--   • a *requested* past listener who can't take them now    → 'preferred_unavailable'
--       (never silently substitute — the seeker decides what to do)
--   • every online listener at active+1                      → 'busy_full' (caller
--       routes to the priority callback path — built separately)
--   • no online/fresh listener at all                        → 'none' (away)
--
-- The two partial unique indexes make the capacity a database guarantee, so
-- concurrent seekers can never double-book a listener (the loser of the race
-- gets a unique_violation and the RPC re-evaluates).

-- ── capacity guarantees ────────────────────────────────────────────────────
-- At most one live chat per listener.
create unique index if not exists cs_one_active_per_listener
  on public.connect_sessions (listener_id)
  where status = 'active' and listener_id is not null;

-- At most one waiting ("next in line") request per listener.
create unique index if not exists cs_one_pending_per_listener
  on public.connect_sessions (listener_id)
  where status = 'pending' and listener_id is not null;

-- ── how many listeners can take someone *right now* (idle) ──────────────────
-- Powers the "someone's available" pill. Idle = online, fresh, no active, no
-- pending. SECURITY DEFINER so it can see every listener's session state.
create or replace function public.minit_available_count()
returns integer
language sql security definer stable set search_path = public as $$
  select count(*)::int
  from public.listeners l
  where l.is_online = true
    and (l.last_seen is null or l.last_seen > now() - interval '120 seconds')
    and not exists (
      select 1 from public.connect_sessions s
      where s.listener_id = l.id and s.status in ('active', 'pending'));
$$;

-- ── match + create a session atomically ────────────────────────────────────
-- Returns one row. For 'preferred_unavailable' / 'busy_full' / 'none' no session
-- is created and session_id / listener_id are null.
create or replace function public.minit_start_session(preferred uuid default null, is_anon boolean default true)
returns table (session_id uuid, listener_id uuid, outcome text, used_preferred boolean)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  fresh constant interval := interval '120 seconds';
  v_id uuid; v_lid uuid; v_status text; v_outcome text;
  chosen uuid; chosen_outcome text;
  attempts int := 0;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  -- Idempotency: if the caller already has an in-flight session, return it
  -- instead of creating a duplicate (the unique indexes would block one anyway).
  select s.id, s.listener_id, s.status into v_id, v_lid, v_status
  from public.connect_sessions s
  where s.user_id = uid and s.status in ('pending', 'active')
  order by s.created_at desc limit 1;
  if found then
    if v_status = 'active' then
      v_outcome := 'open';
    elsif exists (select 1 from public.connect_sessions a
                  where a.listener_id = v_lid and a.status = 'active') then
      v_outcome := 'queued';
    else
      v_outcome := 'open';
    end if;
    return query select v_id, v_lid, v_outcome, false; return;
  end if;

  loop
    attempts := attempts + 1;
    exit when attempts > 8;
    chosen := null; chosen_outcome := null;

    if preferred is not null then
      -- Only this listener — never silently hand the seeker to someone else.
      -- idle → connect now
      select l.id into chosen from public.listeners l
      where l.id = preferred and l.is_online
        and (l.last_seen is null or l.last_seen > now() - fresh)
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
      limit 1;
      if found then
        chosen_outcome := 'open';
      else
        -- busy but waiting slot free → next in line
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
      -- 1) any idle listener → connect now (random spread; swap for a fairness
      --    policy later, e.g. longest-idle-first)
      select l.id into chosen from public.listeners l
      where l.is_online
        and (l.last_seen is null or l.last_seen > now() - fresh)
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
        and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
      order by random() limit 1;
      if found then chosen_outcome := 'open'; end if;

      -- 2) any busy listener with an empty waiting slot → next in line
      if chosen is null then
        select l.id into chosen from public.listeners l
        where l.is_online
          and (l.last_seen is null or l.last_seen > now() - fresh)
          and exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'active')
          and not exists (select 1 from public.connect_sessions s where s.listener_id = l.id and s.status = 'pending')
        order by random() limit 1;
        if found then chosen_outcome := 'queued'; end if;
      end if;

      -- nobody can take them
      if chosen is null then
        if exists (select 1 from public.listeners l where l.is_online
                   and (l.last_seen is null or l.last_seen > now() - fresh)) then
          return query select null::uuid, null::uuid, 'busy_full'::text, false; -- online but all at capacity
        else
          return query select null::uuid, null::uuid, 'none'::text, false;       -- nobody online/fresh
        end if;
        return;
      end if;
    end if;

    -- claim the slot; lose the race → retry with a fresh evaluation
    begin
      insert into public.connect_sessions (user_id, listener_id, session_type, is_anonymous, status)
      values (uid, chosen, 'chat', coalesce(is_anon, true), 'pending')
      returning id into v_id;
    exception when unique_violation then
      continue;
    end;

    return query select v_id, chosen, chosen_outcome, (preferred is not null);
    return;
  end loop;

  -- contention exhausted the retries; treat as full
  return query select null::uuid, null::uuid, 'busy_full'::text, false;
end;
$$;

-- ── where am I in the line? ─────────────────────────────────────────────────
-- A waiting seeker can't read other people's sessions, so they ask the server.
-- With cap=1 the answer is simply: is my listener mid-chat (→ I'm next), or are
-- they free (→ connecting now). Only the session owner gets an answer.
create or replace function public.minit_queue_position(sid uuid)
returns table (listener_busy boolean, ahead integer)
language sql security definer stable set search_path = public as $$
  select
    exists (select 1 from public.connect_sessions a
            where a.listener_id = s.listener_id and a.status = 'active' and a.id <> s.id),
    (select count(*)::int from public.connect_sessions a
     where a.listener_id = s.listener_id and a.status = 'active' and a.id <> s.id)
  from public.connect_sessions s
  where s.id = sid and s.user_id = auth.uid();
$$;

grant execute on function public.minit_available_count() to authenticated;
grant execute on function public.minit_start_session(uuid, boolean) to authenticated;
grant execute on function public.minit_queue_position(uuid) to authenticated;

-- ── reaper: don't strand a queue when its listener disappears ───────────────
-- The active-session reaper already cancels live chats whose listener went
-- offline; do the same for pending ("next in line") requests so a waiting
-- seeker isn't stuck until the 15-minute expiry.
do $$ begin perform cron.unschedule('minit-expire-pending-offline'); exception when others then null; end $$;
select cron.schedule('minit-expire-pending-offline', '*/2 * * * *',
  $$update public.connect_sessions set status='cancelled'
     where status='pending'
       and listener_id is not null
       and listener_id in (select id from public.listeners where is_online = false)$$);
