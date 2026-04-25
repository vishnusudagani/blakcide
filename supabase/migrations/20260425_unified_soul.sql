-- Unified Soul: shared brain, persona, action loop, whisperer.
--
-- All tables are user-scoped and protected by RLS. Service-role writes from
-- Symp.ai bypass RLS via SUPABASE_SERVICE_ROLE_KEY (server-only). Browser
-- access is proxied through /api/blaksyd/symp/* which strips and re-injects
-- user identity from the Supabase JWT.

begin;

-- ── 1. Vibe state (one live row per user) ──────────────────────────────────
create table if not exists public.symp_vibe_state (
    user_id              uuid primary key references auth.users(id) on delete cascade,
    vibe_score           smallint not null default 0
                            check (vibe_score between -100 and 100),
    energy               smallint not null default 50
                            check (energy between 0 and 100),
    primary_emotion      text     not null default 'calm',
    language_lane        text     not null default 'en'
                            check (language_lane in ('te','hi','en','romanized-te','romanized-hi')),
    last_topic           text,
    consecutive_low_days smallint not null default 0,
    streak_days          smallint not null default 0,    -- consecutive engagement
    source_event_id      uuid,
    updated_at           timestamptz not null default now()
);
create index if not exists idx_vibe_state_updated on public.symp_vibe_state (updated_at desc);

-- ── 2. Vibe events (append-only ledger) ────────────────────────────────────
create table if not exists public.symp_vibe_events (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references auth.users(id) on delete cascade,
    source            text not null
                        check (source in ('ai_chat','ai_call','human_chat','human_call','journal','proactive')),
    source_session_id uuid,
    vibe_delta        jsonb not null,
    -- Full state snapshot AFTER applying delta — cheap to store, lets us
    -- reconstruct any historical vibe without replaying deltas.
    vibe_snapshot     jsonb,
    observed_at       timestamptz not null default now()
);
create index if not exists idx_vibe_events_user_time on public.symp_vibe_events (user_id, observed_at desc);
create index if not exists idx_vibe_events_source    on public.symp_vibe_events (source, observed_at desc);

-- ── 3. Persona state (per user) ────────────────────────────────────────────
create table if not exists public.symp_persona_state (
    user_id          uuid primary key references auth.users(id) on delete cascade,
    active_persona   text not null default 'friend'
                        check (active_persona in
                            ('friend','father','mother','astrologer','spiritual','tech_savvy')),
    locked           boolean not null default false,
    last_swapped_at  timestamptz not null default now(),
    swap_history     jsonb not null default '[]'::jsonb,    -- last 20
    updated_at       timestamptz not null default now()
);

-- ── 4. Action loop queue ───────────────────────────────────────────────────
create table if not exists public.symp_action_loop (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    trigger_type    text not null
                       check (trigger_type in
                           ('morning_sweep','distress_pattern','streak_celebrate','silence_7d','custom')),
    scheduled_for   timestamptz not null,
    status          text not null default 'pending'
                       check (status in ('pending','fired','cancelled','failed')),
    payload         jsonb not null default '{}'::jsonb,
    fired_at        timestamptz,
    result          jsonb,
    -- Idempotency: at most one PENDING trigger of a given type per user.
    -- Prevents the CRON from queueing duplicates if it runs twice.
    created_at      timestamptz not null default now()
);
create unique index if not exists uniq_action_pending_per_type
    on public.symp_action_loop (user_id, trigger_type)
    where status = 'pending';
create index if not exists idx_action_due
    on public.symp_action_loop (scheduled_for)
    where status = 'pending';

-- ── 5. Listener briefs (Whisperer pre-session brief) ───────────────────────
create table if not exists public.symp_listener_briefs (
    id                  uuid primary key default gen_random_uuid(),
    connect_session_id  uuid not null unique,
    user_id             uuid not null references auth.users(id) on delete cascade,
    listener_id         uuid not null references auth.users(id) on delete cascade,
    brief               jsonb not null,
    created_at          timestamptz not null default now(),
    consumed_at         timestamptz
);
create index if not exists idx_briefs_listener on public.symp_listener_briefs (listener_id, created_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Users can read their own rows. Service role (Symp.ai server) bypasses RLS
-- and is the only writer. Listeners can read their own briefs.

alter table public.symp_vibe_state       enable row level security;
alter table public.symp_vibe_events      enable row level security;
alter table public.symp_persona_state    enable row level security;
alter table public.symp_action_loop      enable row level security;
alter table public.symp_listener_briefs  enable row level security;

drop policy if exists vibe_state_owner_read on public.symp_vibe_state;
create policy vibe_state_owner_read on public.symp_vibe_state
    for select using (auth.uid() = user_id);

drop policy if exists vibe_events_owner_read on public.symp_vibe_events;
create policy vibe_events_owner_read on public.symp_vibe_events
    for select using (auth.uid() = user_id);

drop policy if exists persona_state_owner_rw on public.symp_persona_state;
create policy persona_state_owner_rw on public.symp_persona_state
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists action_loop_owner_read on public.symp_action_loop;
create policy action_loop_owner_read on public.symp_action_loop
    for select using (auth.uid() = user_id);

drop policy if exists briefs_listener_read on public.symp_listener_briefs;
create policy briefs_listener_read on public.symp_listener_briefs
    for select using (auth.uid() = listener_id or auth.uid() = user_id);

-- ── Helper: trigger to keep symp_vibe_state.updated_at fresh on UPDATE ─────
create or replace function public.symp_touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_vibe_state_touch on public.symp_vibe_state;
create trigger trg_vibe_state_touch
    before update on public.symp_vibe_state
    for each row execute function public.symp_touch_updated_at();

drop trigger if exists trg_persona_state_touch on public.symp_persona_state;
create trigger trg_persona_state_touch
    before update on public.symp_persona_state
    for each row execute function public.symp_touch_updated_at();

commit;
