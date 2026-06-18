-- Minit — Phase 2a: notification foundation + priority callbacks (in-app channel).
--
-- Builds a general, reusable in-app notification inbox (Blaksyd has none today)
-- plus the Minit "notify me when a listener's free" priority list. Web push and
-- WhatsApp (Phase 2b/2c) fan out from the same `notifications` rows, so the
-- in-app channel works standalone and the others layer on without rework.

-- ── general in-app notification inbox (reusable across Blaksyd) ─────────────
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null,                         -- e.g. 'minit_listener_free'
  title text not null,
  body text,
  url text,                                   -- where tapping takes the user
  data jsonb,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  read_at timestamptz
);
alter table public.notifications enable row level security;
drop policy if exists notif_select_own on public.notifications;
create policy notif_select_own on public.notifications for select using (user_id = auth.uid());
drop policy if exists notif_update_own on public.notifications;
create policy notif_update_own on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Inserts come only from SECURITY DEFINER functions / service role (no client insert).
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc) where read_at is null;

-- Realtime so the banner appears instantly (poll is the fallback in the client).
do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ── priority callback list ──────────────────────────────────────────────────
create table if not exists public.minit_callbacks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  preferred_listener_id uuid,                 -- null = any listener
  is_anonymous boolean not null default true,
  status text not null default 'waiting',     -- waiting | notified | fulfilled | cancelled
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
alter table public.minit_callbacks enable row level security;
drop policy if exists mcb_rw_own on public.minit_callbacks;
create policy mcb_rw_own on public.minit_callbacks for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists mcb_admin_read on public.minit_callbacks;
create policy mcb_admin_read on public.minit_callbacks for select using (is_admin());
-- One open request per user.
create unique index if not exists minit_callbacks_one_waiting
  on public.minit_callbacks (user_id) where status = 'waiting';

-- Join (or refresh) the priority list. preferred null = "any listener".
create or replace function public.minit_request_callback(preferred uuid default null, is_anon boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into v_id from public.minit_callbacks where user_id = auth.uid() and status = 'waiting';
  if v_id is null then
    insert into public.minit_callbacks (user_id, preferred_listener_id, is_anonymous)
    values (auth.uid(), preferred, coalesce(is_anon, true)) returning id into v_id;
  else
    update public.minit_callbacks
      set preferred_listener_id = preferred, is_anonymous = coalesce(is_anon, true), created_at = now()
      where id = v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function public.minit_request_callback(uuid, boolean) to authenticated;

-- ── the engine: a listener freed up → notify the next in line ───────────────
-- Priority: someone waiting specifically for THIS listener first, then any-listener
-- requests in arrival order (FIFO). Writes an in-app notification; push/WhatsApp
-- (Phase 2b/2c) will fan out from the same row.
create or replace function public.minit_notify_next_callback(p_listener uuid)
returns void language plpgsql security definer set search_path = public as $$
declare cb record;
begin
  if p_listener is null then return; end if;

  -- the listener must actually be free right now (online, fresh, idle)
  if not exists (
    select 1 from public.listeners l
    where l.id = p_listener and l.is_online
      and (l.last_seen is null or l.last_seen > now() - interval '120 seconds')
      and not exists (select 1 from public.connect_sessions s
                      where s.listener_id = l.id and s.status in ('active', 'pending'))
  ) then return; end if;

  select * into cb from public.minit_callbacks
  where status = 'waiting'
    and (preferred_listener_id = p_listener or preferred_listener_id is null)
  order by (preferred_listener_id = p_listener) desc, created_at asc
  limit 1;
  if not found then return; end if;

  update public.minit_callbacks set status = 'notified', notified_at = now() where id = cb.id;

  insert into public.notifications (user_id, kind, title, body, url, data)
  values (cb.user_id, 'minit_listener_free', 'A listener''s free',
          'Someone''s available to talk on Minit right now — tap to connect.',
          '/beta/minit/', jsonb_build_object('listener_id', p_listener, 'callback_id', cb.id));
end;
$$;

-- live chat ended → that listener may now be free
create or replace function public.trg_cs_freed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status in ('completed', 'cancelled') and new.listener_id is not null then
    perform public.minit_notify_next_callback(new.listener_id);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_cs_freed on public.connect_sessions;
create trigger trg_cs_freed after update on public.connect_sessions
  for each row execute function public.trg_cs_freed();

-- listener just came online → they may be free
create or replace function public.trg_listener_online() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.is_online, false) and not coalesce(old.is_online, false) then
    perform public.minit_notify_next_callback(new.id);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_listener_online on public.listeners;
create trigger trg_listener_online after update on public.listeners
  for each row execute function public.trg_listener_online();
