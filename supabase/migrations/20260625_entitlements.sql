-- Entitlements foundation — the generic feature-gate Blaksyd lacks.
--
-- Today the only gate is Minit's time limit. There is no way to ask "can this
-- user use feature X" or to attach features to a paid plan. This adds:
--   billing_plans       — catalogue of plans + their feature flags/quotas
--   user_subscriptions  — which plan a user is on (written by billing webhooks
--                          / admin only; users with no row resolve to 'free')
--   entitlement_grants  — ad-hoc grants (comps, trials, referral perks)
-- plus has_entitlement(feature) / entitlement_quota(feature) / current_plan()
-- RPCs scoped to auth.uid(). Provider-AGNOSTIC: Stripe/Razorpay/IAP just write
-- user_subscriptions on payment. Nothing changes today — everyone is 'free' and
-- no code calls the gate yet; it's ready for the billing wave to switch on.
--
-- Pricing is intentionally NOT set here (it's unresolved per CLAUDE.md). Plans
-- carry only structure + feature flags; the paid plan ships is_active=false.

-- ── Plans ────────────────────────────────────────────────────────────────
create table if not exists public.billing_plans (
    plan_id     text primary key,
    name        text not null,
    description text,
    monthly_inr numeric,          -- null until pricing is decided
    monthly_usd numeric,
    features    jsonb not null default '{}'::jsonb,  -- { feature_key: true | <quota int> }
    sort        int  not null default 0,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

insert into public.billing_plans (plan_id, name, description, features, sort, is_active) values
    ('free', 'Free', 'Everything in the beta today.', '{}'::jsonb, 0, true)
on conflict (plan_id) do nothing;

-- Illustrative paid tier — shape only, NOT yet offered (is_active=false). Edit
-- features/pricing once packaging is decided; the gate already honours these.
insert into public.billing_plans (plan_id, name, description, features, sort, is_active) values
    ('plus', 'Plus', 'Priority + premium features.',
     '{"minit_priority": true, "persona_voice": true, "blak_priority_llm": true, "persona_max": 25}'::jsonb,
     10, false)
on conflict (plan_id) do nothing;

-- ── Subscriptions (one current plan per user) ──────────────────────────────
create table if not exists public.user_subscriptions (
    user_id                 uuid primary key references auth.users(id) on delete cascade,
    plan_id                 text not null references public.billing_plans(plan_id),
    status                  text not null default 'active'
                              check (status in ('active','trialing','past_due','canceled','incomplete')),
    provider                text,    -- 'stripe' | 'razorpay' | 'iap' | 'play' | 'manual'
    provider_customer_id    text,
    provider_subscription_id text,
    current_period_end      timestamptz,
    cancel_at_period_end    boolean not null default false,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);
create index if not exists idx_user_subscriptions_status on public.user_subscriptions (status);

-- ── Ad-hoc grants (comps / trials / referral perks) ────────────────────────
create table if not exists public.entitlement_grants (
    id          bigint generated always as identity primary key,
    user_id     uuid not null references auth.users(id) on delete cascade,
    feature     text not null,
    quota       integer,           -- null = boolean grant
    expires_at  timestamptz,       -- null = permanent
    reason      text,
    created_at  timestamptz not null default now()
);
create index if not exists idx_entitlement_grants_user on public.entitlement_grants (user_id, feature);

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table public.billing_plans       enable row level security;
alter table public.user_subscriptions  enable row level security;
alter table public.entitlement_grants  enable row level security;

drop policy if exists bp_read_active on public.billing_plans;
create policy bp_read_active on public.billing_plans
    for select to anon, authenticated using (is_active);

drop policy if exists us_read_own on public.user_subscriptions;
create policy us_read_own on public.user_subscriptions
    for select to authenticated using (user_id = auth.uid());
-- writes: service role only (billing webhooks / admin) — no user write policy.

drop policy if exists eg_read_own on public.entitlement_grants;
create policy eg_read_own on public.entitlement_grants
    for select to authenticated using (user_id = auth.uid());

-- ── Gate RPCs (scoped to auth.uid(); safe to call from the client) ─────────
create or replace function public.has_entitlement(p_feature text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); pid text; feats jsonb; v jsonb;
begin
    if uid is null or p_feature is null then return false; end if;
    if exists (select 1 from entitlement_grants g
               where g.user_id = uid and g.feature = p_feature
                 and (g.expires_at is null or g.expires_at > now())) then
        return true;
    end if;
    select s.plan_id into pid from user_subscriptions s
        where s.user_id = uid and s.status in ('active','trialing') limit 1;
    if pid is null then pid := 'free'; end if;
    select features into feats from billing_plans where plan_id = pid;
    if feats is null then return false; end if;
    v := feats -> p_feature;
    if v is null then return false; end if;
    -- truthy: boolean true, or a positive number
    if jsonb_typeof(v) = 'boolean' then return v = 'true'::jsonb; end if;
    if jsonb_typeof(v) = 'number'  then return (v::text)::numeric > 0; end if;
    return false;
end $$;

create or replace function public.entitlement_quota(p_feature text)
returns integer
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); pid text; feats jsonb; v jsonb; g_quota integer;
begin
    if uid is null or p_feature is null then return 0; end if;
    select max(g.quota) into g_quota from entitlement_grants g
        where g.user_id = uid and g.feature = p_feature
          and (g.expires_at is null or g.expires_at > now());
    select s.plan_id into pid from user_subscriptions s
        where s.user_id = uid and s.status in ('active','trialing') limit 1;
    if pid is null then pid := 'free'; end if;
    select features into feats from billing_plans where plan_id = pid;
    v := feats -> p_feature;
    if v is not null and jsonb_typeof(v) = 'number' then
        return greatest(coalesce(g_quota, 0), (v::text)::numeric::integer);
    end if;
    return coalesce(g_quota, 0);
end $$;

create or replace function public.current_plan()
returns table(plan_id text, name text, status text, current_period_end timestamptz, cancel_at_period_end boolean)
language sql security definer set search_path = public as $$
    select coalesce(s.plan_id, 'free') as plan_id,
           p.name,
           coalesce(s.status, 'active') as status,
           s.current_period_end,
           coalesce(s.cancel_at_period_end, false) as cancel_at_period_end
    from (select auth.uid() as uid) base
    left join user_subscriptions s on s.user_id = base.uid and s.status in ('active','trialing')
    left join billing_plans p on p.plan_id = coalesce(s.plan_id, 'free')
$$;

revoke all on function public.has_entitlement(text)  from public, anon;
revoke all on function public.entitlement_quota(text) from public, anon;
revoke all on function public.current_plan()          from public, anon;
grant execute on function public.has_entitlement(text)  to authenticated;
grant execute on function public.entitlement_quota(text) to authenticated;
grant execute on function public.current_plan()          to authenticated;
