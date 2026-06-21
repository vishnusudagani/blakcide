-- App integrations — the connection STATE for the "Your apps" grid in the beta
-- account page. The CATALOG of apps (Swiggy, Zomato, Blinkit, Zepto, Instamart,
-- Uber, Ola, Rapido…) lives in code (src/lib/integrations-catalog.mjs); this
-- table records which providers a given user has actually connected and how.
--
-- The two rails (see the integrations spec):
--   • LEARN  — Blak rebuilds your order/ride history from receipts. One Gmail
--              connection covers every app; SMS arrives with the native app later.
--   • ACT    — Blak completes orders itself. Real (headless) only via ONDC
--              (cabs first); the big food/grocery brands have no consumer API, so
--              they stay deep-link ("prepare → you confirm in the app").
--
-- SECURITY: this table holds NO secrets. OAuth refresh/access tokens are NEVER
-- stored here and never reach the browser — they belong in a server-only,
-- service-role-encrypted store added with the Gmail OAuth backend. Owner-only RLS,
-- mirroring symp_knowledge_facts, keeps every row fully user-owned.

create table if not exists public.symp_integrations (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users(id) on delete cascade,
    provider      text not null,                       -- 'gmail','swiggy','zomato','blinkit','zepto','instamart','uber','ola','rapido'
    category      text not null default 'other'
                     check (category in ('account','food','quick_commerce','cabs','other')),
    status        text not null default 'connected'
                     check (status in ('pending','connected','learning','paused','error')),
    display_name  text,                                -- e.g. the connected Gmail address (non-secret)
    account_ref   text,                                -- external account handle/id (non-secret)
    scopes        text[] not null default '{}',        -- granted read scopes (e.g. gmail.readonly)
    last_sync_at  timestamptz,                         -- last successful receipt/history sync
    meta          jsonb not null default '{}'::jsonb,  -- non-secret metadata (counts, detected-from-receipts…)
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    unique (user_id, provider)
);

create index if not exists idx_integrations_user
    on public.symp_integrations (user_id);

alter table public.symp_integrations enable row level security;

-- Owner-only: the user fully controls their own connections (the "fully
-- user-owned" decision). The service-role backend (Gmail parser, ONDC) bypasses RLS.
drop policy if exists integrations_owner_read on public.symp_integrations;
create policy integrations_owner_read on public.symp_integrations
    for select using (auth.uid() = user_id);

drop policy if exists integrations_owner_write on public.symp_integrations;
create policy integrations_owner_write on public.symp_integrations
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Reuse the shared updated_at touch trigger (defined in earlier migrations).
drop trigger if exists trg_integrations_touch on public.symp_integrations;
create trigger trg_integrations_touch
    before update on public.symp_integrations
    for each row execute function symp_touch_updated_at();
