-- Knowledge profile — the structured, user-visible "what Blak knows about you".
--
-- Blak fills this silently from conversation (service-role writes via the
-- knowledge-extractor); the user can see, edit, and delete everything from the
-- /beta/profile page (owner-only RLS, so the browser client reads/writes its
-- own rows directly). It doubles as the context engine: a compact core is
-- always injected, deeper facts are pulled in by relevance.
--
-- Hybrid schema (see symp-core/lib/knowledge-schema.mjs): `area` + `key` map to
-- a fixed taxonomy, plus an open bucket (area='other') for novel facts.
-- Provenance lives on every row: source (told vs inferred), confidence, dates.

create table if not exists public.symp_knowledge_facts (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users(id) on delete cascade,
    area          text not null
                     check (area in ('identity','people','world','inner','goals','tastes','other')),
    key           text not null,                       -- stable slug within the area
    label         text,                                -- human label for display
    value         text not null,                       -- the fact itself (plain text)
    source        text not null default 'blak'
                     check (source in ('user','blak')), -- told-by-user vs inferred-by-Blak
    confidence    real not null default 0.6
                     check (confidence >= 0 and confidence <= 1),
    status        text not null default 'active'
                     check (status in ('active','user_edited')), -- user_edited = locked truth
    evidence      text,                                -- optional: why Blak believes this
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),  -- bumped when re-observed
    unique (user_id, area, key)
);

create index if not exists idx_knowledge_facts_user
    on public.symp_knowledge_facts (user_id);
create index if not exists idx_knowledge_facts_user_area
    on public.symp_knowledge_facts (user_id, area);

alter table public.symp_knowledge_facts enable row level security;

-- Owner-only: the user can see and fully control their own knowledge (per the
-- "fully user-owned" decision). Service-role (extractor) bypasses RLS.
drop policy if exists knowledge_facts_owner_read on public.symp_knowledge_facts;
create policy knowledge_facts_owner_read on public.symp_knowledge_facts
    for select using (auth.uid() = user_id);

drop policy if exists knowledge_facts_owner_write on public.symp_knowledge_facts;
create policy knowledge_facts_owner_write on public.symp_knowledge_facts
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Reuse the shared updated_at touch trigger (defined in earlier migrations).
drop trigger if exists trg_knowledge_facts_touch on public.symp_knowledge_facts;
create trigger trg_knowledge_facts_touch
    before update on public.symp_knowledge_facts
    for each row execute function symp_touch_updated_at();
