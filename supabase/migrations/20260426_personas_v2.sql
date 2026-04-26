-- Persona modes v2 — adds Therapist + persona-scoped facts.
--
-- Why two changes in one migration:
--   1. The therapist persona is a brand-new active option, so we need to
--      relax the CHECK constraint on symp_persona_state.active_persona.
--   2. Astrologer and Spiritual modes need to *remember* per-user facts
--      across sessions (DOB/TOB/POB for astrology charts, religion for
--      scripture-aware spiritual guidance). These facts are persona-scoped
--      and not vault-analysis derivatives, so they live in their own table
--      rather than polluting symp_vault_profiles.

-- ── 1. Therapist persona ──────────────────────────────────────────────────
alter table public.symp_persona_state
    drop constraint if exists symp_persona_state_active_persona_check;

alter table public.symp_persona_state
    add constraint symp_persona_state_active_persona_check
    check (active_persona in
        ('friend','father','mother','astrologer','spiritual','tech_savvy','therapist'));

-- ── 2. Persona-scoped facts ──────────────────────────────────────────────
-- One row per (user, persona). The `facts` JSONB shape is persona-defined:
--   astrologer → { dob:'YYYY-MM-DD', tob:'HH:MM', pob:'City, Country',
--                  asked_at:ISO, charts_summary?:string }
--   spiritual  → { religion:'hindu|muslim|christian|sikh|buddhist|jain|none|other',
--                  asked_at:ISO, prefers_scriptures?:[ ... ] }
--   (others may add their own keys later.)
--
-- We never delete rows on persona swap — facts persist so a user can
-- swap-back without re-collecting birth details.
create table if not exists public.symp_persona_facts (
    user_id     uuid not null references auth.users(id) on delete cascade,
    persona_id  text not null
                   check (persona_id in
                       ('friend','father','mother','astrologer','spiritual','tech_savvy','therapist')),
    facts       jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    primary key (user_id, persona_id)
);

create index if not exists idx_persona_facts_user
    on public.symp_persona_facts (user_id);

alter table public.symp_persona_facts enable row level security;

drop policy if exists persona_facts_owner_read on public.symp_persona_facts;
create policy persona_facts_owner_read on public.symp_persona_facts
    for select using (auth.uid() = user_id);

drop policy if exists persona_facts_owner_write on public.symp_persona_facts;
create policy persona_facts_owner_write on public.symp_persona_facts
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_persona_facts_touch on public.symp_persona_facts;
create trigger trg_persona_facts_touch
    before update on public.symp_persona_facts
    for each row execute function symp_touch_updated_at();
