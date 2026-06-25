-- Analytics & observability foundation — a generic first-party event store.
--
-- Today Blaksyd has NO product analytics or error monitoring (only a few
-- domain-specific event logs). This table is the single sink behind a uniform
-- track() helper (src/lib/analytics.ts client + symp-core/lib/analytics.mjs
-- server). It works with ZERO external dependency — queryable in Supabase from
-- day one — and the same track() calls forward to PostHog/Plausible/GA the
-- moment a PUBLIC_* provider key is set (see the capability registry).
--
-- Privacy (DPDP): rows are owner-scoped, contain only an event name + coarse
-- props (no secrets — the firewall already strips those upstream), and are
-- removed by delete_my_account() since user_id is an owner column with ON
-- DELETE CASCADE. Capture is OFF until PUBLIC_ANALYTICS=1 is set at build time.

create table if not exists public.analytics_events (
    id          bigint generated always as identity primary key,
    user_id     uuid references auth.users(id) on delete cascade,
    event       text not null,
    props       jsonb not null default '{}'::jsonb,
    path        text,
    session_id  text,
    created_at  timestamptz not null default now()
);

create index if not exists idx_analytics_events_event_time on public.analytics_events (event, created_at desc);
create index if not exists idx_analytics_events_user_time  on public.analytics_events (user_id, created_at desc);

alter table public.analytics_events enable row level security;

-- Signed-in users may insert ONLY their own events. No SELECT policy for the
-- authenticated role → reads are service-role / admin only (keeps the funnel
-- data out of the client). Service role bypasses RLS for server-side track().
drop policy if exists ae_insert_own on public.analytics_events;
create policy ae_insert_own on public.analytics_events
    for insert to authenticated
    with check (user_id = auth.uid());

comment on table public.analytics_events is
    'First-party product analytics + client error sink. Owner-insert RLS; admin/service read. Gated on PUBLIC_ANALYTICS.';
