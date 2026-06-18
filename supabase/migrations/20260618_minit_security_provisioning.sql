-- Minit — Phase 1: security & listener provisioning.
--
-- Closes the holes found in the RLS/advisor audit and replaces "anyone can make
-- themselves a listener" with admin provisioning, so the 2–3 real listeners can
-- be onboarded safely. DB-only — the consoles already read just their own
-- listener row (matching moved to RPCs in the queue-matching migration), so
-- tightening the listeners SELECT policy does not change client behaviour.

-- ── 1) listeners: no self-enroll, no world-readable PII ─────────────────────
-- Was: "Anyone can view listeners" USING (true)  → exposed user_id + pricing to
-- everyone, and "Listeners can insert own profile" → any signed-in user could
-- grant themselves listener powers. Both removed.
drop policy if exists "Anyone can view listeners" on public.listeners;
drop policy if exists "Listeners can insert own profile" on public.listeners;

-- A listener can read their own row (the console loads its own profile).
drop policy if exists "listeners_select_own" on public.listeners;
create policy "listeners_select_own" on public.listeners
  for select using (auth.uid() = user_id);

-- One listener row per user (enables safe provisioning upsert; prevents dupes).
create unique index if not exists listeners_user_id_uk
  on public.listeners (user_id) where user_id is not null;

-- Everyone else sees only safe, non-PII fields — via a view that omits user_id.
-- (Powers the future Listener Discovery directory; nothing reads it yet.)
create or replace view public.listeners_public as
  select id, display_name, profile_pic, bio, languages, rating, reviews_count,
         chat_price_per_min, call_price_per_min, is_online, last_seen
  from public.listeners;
grant select on public.listeners_public to authenticated;

-- ── 2) connect_sessions: server-owned lifecycle (stops credit-gaming) ───────
-- cs_update_party lets either party UPDATE the row, with no column constraint —
-- so a seeker could rewrite activated_at/ended_at (minutes are billed from those)
-- or self-activate a session. This trigger makes the timestamps and the accept
-- transition server-owned. End-user-less contexts (cron reaper, admin RPCs where
-- auth.uid() is null) are trusted and skip the checks.
create or replace function public.connect_sessions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;          -- cron / service: trusted

  if old.status in ('completed','cancelled','rejected') then
    raise exception 'session is closed';                  -- terminal rows immutable
  end if;

  -- activated_at is server-owned: set once on accept, never rewritten by a client
  if old.activated_at is not null then new.activated_at := old.activated_at; end if;

  if new.status = 'active' and old.status = 'pending' then
    if not (uid_is_listener(old.listener_id) or is_admin()) then
      raise exception 'only the assigned listener can accept';
    end if;
    new.activated_at := now();
  elsif new.status = 'active' and old.status <> 'active' then
    raise exception 'invalid transition to active';
  end if;

  -- ended_at is server-owned: stamped only when the session completes
  if new.status = 'completed' then new.ended_at := now(); else new.ended_at := old.ended_at; end if;

  return new;
end;
$$;

drop trigger if exists trg_connect_sessions_guard on public.connect_sessions;
create trigger trg_connect_sessions_guard
  before update on public.connect_sessions
  for each row execute function public.connect_sessions_guard();

-- ── 3) admin-only listener provisioning ────────────────────────────────────
-- The person signs up normally, then an admin promotes them by email. Replaces
-- raw DB inserts and the (now removed) self-enroll path. Full apply→approve UI
-- is Phase 4 (moderation/admin console); this is the secure primitive.
create or replace function public.admin_provision_listener(
  p_email text, p_display_name text default null, p_languages text[] default null, p_bio text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select id into v_uid from auth.users where lower(email) = lower(p_email) limit 1;
  if v_uid is null then raise exception 'no user with email %', p_email; end if;

  select id into v_id from public.listeners where user_id = v_uid;
  if v_id is null then
    insert into public.listeners (user_id, display_name, languages, bio, is_online)
    values (v_uid, coalesce(p_display_name, split_part(p_email, '@', 1)), p_languages, p_bio, false)
    returning id into v_id;
  else
    update public.listeners
      set display_name = coalesce(p_display_name, display_name),
          languages    = coalesce(p_languages, languages),
          bio          = coalesce(p_bio, bio)
      where id = v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function public.admin_provision_listener(text, text, text[], text) to authenticated;

-- Note: session_seeker_name (anon-callable, SECURITY DEFINER) was reviewed — it
-- is only meaningful for a party to a non-anonymous session and returns nothing
-- otherwise; left as-is. Revisit with a caller-authorization check in Phase 4.
