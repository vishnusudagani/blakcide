-- Profile foundation — the hybrid data layer behind the "50 things" build-out of
-- the /beta/profile ("What Blak knows about you") surface.
--
-- Design (decided with the owner): HYBRID. Keep the flat symp_knowledge_facts
-- table working untouched and EXTEND it with the cheap, high-value columns
-- (per-fact visibility, never-raise, evidence provenance, freshness, validity,
-- pin/archive); then add a small set of focused tables only where flat strings
-- genuinely can't model the thing:
--   • symp_knowledge_entities      people / pets / places / orgs as first-class
--   • symp_knowledge_events        dated events → life timeline & countdowns
--   • symp_knowledge_fact_history  versioning (a fact's value over time)
--   • symp_knowledge_tombstones    "forget this and don't relearn it"
--   • symp_goals                   living goals / habits / wins (identity-based)
--   • symp_profile_settings        consent-first toggles (enrichment, sharing, pause)
--   • symp_profile_synthesis       cached "About you" narrative (the identity mirror)
--
-- Mood is NOT a new table: it reuses the existing mood_logs + blak_insights()
-- (kept subtle / non-clinical, never a "tracker"); per-topic feeling lives on
-- symp_knowledge_entities.sentiment. Reminders reuse blak_reminders.
--
-- Privacy stance (consent-first): visibility defaults to 'shared' (Blak may use a
-- fact across pillars) BUT every cross-pillar hand-off previews before sending;
-- 'blak_only' = used only in 1:1 Blak; 'private' = stored, never used in any
-- generation. Passive enrichment toggles all default OFF.
--
-- All owner-only RLS (matching 20260618_knowledge_profile.sql); the service-role
-- extractor bypasses RLS. Re-uses the shared symp_touch_updated_at() trigger.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Extend symp_knowledge_facts
-- ──────────────────────────────────────────────────────────────────────────
alter table public.symp_knowledge_facts
    add column if not exists visibility text not null default 'shared'
        check (visibility in ('shared','blak_only','private'));
alter table public.symp_knowledge_facts
    add column if not exists never_raise boolean not null default false;
alter table public.symp_knowledge_facts
    add column if not exists evidence_at timestamptz;          -- when the 'why' was observed
alter table public.symp_knowledge_facts
    add column if not exists source_kind text;                 -- chat|voice|call|user|gmail|calendar|...
alter table public.symp_knowledge_facts
    add column if not exists source_ref text;                  -- thread/message id to jump back to
alter table public.symp_knowledge_facts
    add column if not exists last_confirmed_at timestamptz;    -- user re-confirmed it's still true
alter table public.symp_knowledge_facts
    add column if not exists valid_until timestamptz;          -- for time-bounded facts (ongoing sagas)
alter table public.symp_knowledge_facts
    add column if not exists pinned boolean not null default false;
alter table public.symp_knowledge_facts
    add column if not exists archived boolean not null default false;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Entities — people, pets, places, orgs, things as first-class records
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_knowledge_entities (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users(id) on delete cascade,
    kind         text not null check (kind in ('person','pet','place','org','thing')),
    name         text not null,
    role         text,                                   -- 'sister','manager','hometown'
    relation     text,                                   -- relationship to the user
    notes        text,                                   -- what matters about them
    avatar_url   text,                                   -- a face for the entity (#37)
    birthday     date,                                   -- feeds anniversaries (#36)
    sentiment    real check (sentiment is null or (sentiment >= -1 and sentiment <= 1)), -- derived feeling toward (#23)
    importance   real not null default 0.5 check (importance >= 0 and importance <= 1),
    sensitive    boolean not null default false,
    never_raise  boolean not null default false,
    visibility   text not null default 'shared' check (visibility in ('shared','blak_only','private')),
    source       text not null default 'blak' check (source in ('user','blak')),
    confidence   real not null default 0.6 check (confidence >= 0 and confidence <= 1),
    status       text not null default 'active' check (status in ('active','user_edited')),
    metadata     jsonb not null default '{}',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    unique (user_id, kind, name)
);
create index if not exists idx_kn_entities_user      on public.symp_knowledge_entities (user_id);
create index if not exists idx_kn_entities_user_kind on public.symp_knowledge_entities (user_id, kind);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Events — dated facts → timeline, milestones, anniversaries, countdowns
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_knowledge_events (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users(id) on delete cascade,
    title        text not null,
    kind         text not null default 'event'
                   check (kind in ('event','milestone','anniversary','plan','memory')),
    occurred_on  date,                                   -- the day (life events)
    occurred_at  timestamptz,                            -- precise instant if known
    end_on       date,
    all_day      boolean not null default true,
    recurrence   text check (recurrence is null or recurrence in ('yearly','monthly','weekly')),
    entity_id    uuid references public.symp_knowledge_entities(id) on delete set null,
    fact_id      uuid references public.symp_knowledge_facts(id)    on delete set null,
    notes        text,
    source       text not null default 'blak' check (source in ('user','blak')),
    source_kind  text,
    source_ref   text,
    confidence   real not null default 0.6 check (confidence >= 0 and confidence <= 1),
    status       text not null default 'active' check (status in ('active','user_edited')),
    visibility   text not null default 'shared' check (visibility in ('shared','blak_only','private')),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index if not exists idx_kn_events_user     on public.symp_knowledge_events (user_id);
create index if not exists idx_kn_events_user_day on public.symp_knowledge_events (user_id, occurred_on);

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Fact history — a fact's value over time (no FK: history outlives the fact)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_knowledge_fact_history (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    fact_id     uuid,
    area        text,
    key         text,
    old_value   text,
    new_value   text,
    changed_by  text not null default 'blak' check (changed_by in ('user','blak','system')),
    reason      text,
    changed_at  timestamptz not null default now()
);
create index if not exists idx_kn_history_user on public.symp_knowledge_fact_history (user_id, changed_at desc);
create index if not exists idx_kn_history_fact on public.symp_knowledge_fact_history (fact_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Tombstones — "forget this, and never relearn it" (delete that stays gone)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_knowledge_tombstones (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    scope       text not null default 'fact' check (scope in ('fact','value','entity')),
    area        text,
    key         text,
    value_norm  text,                                    -- normalized value to block re-learning
    reason      text,
    created_at  timestamptz not null default now(),
    unique (user_id, area, key, value_norm)
);
create index if not exists idx_kn_tombstones_user on public.symp_knowledge_tombstones (user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 6. Goals — living goals / habits / dreams / wins (identity-based, non-punitive)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_goals (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    title           text not null,
    kind            text not null default 'goal' check (kind in ('goal','habit','dream','win')),
    identity        text,                                -- 'becoming a runner' framing
    status          text not null default 'active' check (status in ('active','done','paused','dropped')),
    target_date     date,
    cadence         text check (cadence is null or cadence in ('daily','weekly','monthly')),
    streak          int not null default 0,              -- counted, NEVER shamed on loss
    best_streak     int not null default 0,
    last_checked_on date,
    progress        real check (progress is null or (progress >= 0 and progress <= 1)),
    celebrate       boolean not null default false,
    related_fact_id uuid references public.symp_knowledge_facts(id) on delete set null,
    reminder_id     uuid,                                -- → blak_reminders.id (optional)
    source          text not null default 'user' check (source in ('user','blak')),
    confidence      real not null default 1 check (confidence >= 0 and confidence <= 1),
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists idx_goals_user        on public.symp_goals (user_id);
create index if not exists idx_goals_user_status on public.symp_goals (user_id, status);

-- ──────────────────────────────────────────────────────────────────────────
-- 7. Profile settings — consent-first toggles (one row per user)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_profile_settings (
    user_id         uuid primary key references auth.users(id) on delete cascade,
    learning_paused boolean not null default false,      -- off-the-record / pause learning (#18)
    enrich_gmail    boolean not null default false,      -- opt-in passive enrichment (#46)
    enrich_calendar boolean not null default false,      -- (#47)
    enrich_music    boolean not null default false,      -- (#48)
    enrich_location boolean not null default false,      -- (#50)
    share_minit     boolean not null default true,       -- profile may build a Minit brief (preview first) (#41)
    share_persona   boolean not null default true,       -- profile may train the Real Persona (#42)
    share_nexus     boolean not null default false,      -- interests → tribe suggestions (more public, off) (#44)
    mirror_tone     text not null default 'warm',
    updated_at      timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- 8. Profile synthesis — cached "About you" narrative (the identity mirror, #36)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.symp_profile_synthesis (
    user_id      uuid primary key references auth.users(id) on delete cascade,
    narrative    text,
    fact_count   int not null default 0,
    model        text,
    generated_at timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — owner-only everywhere (service-role bypasses). Matches the existing
-- knowledge-profile policy shape exactly.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.symp_knowledge_entities     enable row level security;
alter table public.symp_knowledge_events        enable row level security;
alter table public.symp_knowledge_fact_history  enable row level security;
alter table public.symp_knowledge_tombstones    enable row level security;
alter table public.symp_goals                   enable row level security;
alter table public.symp_profile_settings        enable row level security;
alter table public.symp_profile_synthesis       enable row level security;

-- Owner full control: entities, events, goals, settings, synthesis, tombstones
do $$
declare t text;
begin
  foreach t in array array[
    'symp_knowledge_entities','symp_knowledge_events','symp_goals',
    'symp_profile_settings','symp_profile_synthesis','symp_knowledge_tombstones'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t || '_owner_all', t
    );
  end loop;
end$$;

-- Fact history: owner may READ their timeline; writes come from the service role.
drop policy if exists symp_knowledge_fact_history_owner_read on public.symp_knowledge_fact_history;
create policy symp_knowledge_fact_history_owner_read on public.symp_knowledge_fact_history
    for select using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- updated_at touch triggers (reuse the shared function from earlier migrations)
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'symp_knowledge_entities','symp_knowledge_events','symp_goals','symp_profile_settings'
  ] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_touch', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function symp_touch_updated_at()',
      'trg_' || t || '_touch', t
    );
  end loop;
end$$;
