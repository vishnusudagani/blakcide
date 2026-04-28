-- ── Blaksyd Credit System — wallet + audit ledger + atomic adjuster ─────────
--
-- Design pillars:
--
--   1. Single source of truth on balance. `symp_credit_wallets.current_credits`
--      is the only authoritative number — every screen, every check, every
--      gate reads from here. The lifetime totals are bookkeeping only.
--
--   2. Append-only audit ledger. Every change to a wallet — admin grant, AI
--      spend, future Stripe purchase, refund — writes a row to
--      `symp_credit_transactions` BEFORE the wallet update commits. The ledger
--      is the receipt; if the two ever diverge, the ledger is the truth.
--
--   3. Atomic, race-safe adjustment. The `adjust_credits()` RPC takes the
--      wallet row lock, recomputes the balance, refuses to go negative, and
--      writes both the wallet update and the ledger row in one transaction.
--      Concurrent spends from two AI sessions cannot drift the balance.
--
--   4. RLS owner-read. Browsers can SELECT only their own rows. Mutations are
--      gated behind the RPC (which is SECURITY DEFINER — service-role logic
--      runs inside it, but ordinary callers cannot insert directly).
--
--   5. Admin-aware. Admin role lives in `public.profiles.role = 'admin'`
--      (already present in the codebase). The RLS policies and the admin
--      endpoints both rely on this single source so we don't grow yet another
--      role table.
--
-- Reuse:
--   - We already have `auth.users` (Supabase) and `public.profiles` (with the
--     `role` column the admin dashboard checks). No new role infrastructure.
--   - The `request_id` column in the ledger maps to the SYMP_REQUEST_ID_HEADER
--     value so any wallet move can be traced back to a single API call.
--
-- Stripe-ready:
--   The `transaction_type` enum has `grant_purchase` reserved for paid
--   top-ups. Phase 2 will introduce a Stripe webhook handler that calls
--   `adjust_credits()` with that type — no schema changes needed.

begin;

-- ── 1. Wallet row, one per user ─────────────────────────────────────────────
create table if not exists public.symp_credit_wallets (
    user_id           uuid primary key references auth.users(id) on delete cascade,
    -- Current spendable balance. NEVER allowed to go negative — enforced
    -- both in the CHECK constraint AND inside the adjust_credits() RPC so
    -- the error surfaces with a clean SQLSTATE the API can map to 402.
    current_credits   integer     not null default 0 check (current_credits >= 0),
    -- Bookkeeping — sum of all positive grants and sum of |negative spends|.
    -- Useful for analytics; not used for spend gating.
    lifetime_granted  bigint      not null default 0 check (lifetime_granted >= 0),
    lifetime_spent    bigint      not null default 0 check (lifetime_spent  >= 0),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- ── 2. Append-only audit ledger ─────────────────────────────────────────────
create table if not exists public.symp_credit_transactions (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid        not null references auth.users(id) on delete cascade,
    -- Positive integer = credit added; negative integer = credit spent.
    -- The RPC enforces that the resulting wallet balance stays >= 0.
    amount            integer     not null,
    -- Why this row exists. The set is fixed so reporting can group cleanly.
    --   admin_grant       — manual adjustment by an admin (positive or negative)
    --   purchase          — paid top-up via Stripe (Phase 2)
    --   promo / referral  — system-issued top-ups
    --   spend_ai_chat     — AI Companion message/turn cost
    --   spend_human       — Human Connect session cost
    --   refund            — reversal of a prior spend
    --   correction        — drift-fix between ledger and wallet
    transaction_type  text        not null check (transaction_type in (
                          'admin_grant', 'purchase', 'promo', 'referral',
                          'spend_ai_chat', 'spend_human', 'refund', 'correction'
                      )),
    -- Snapshot of the wallet balance AFTER this row was applied. Lets us
    -- replay history without joining and lets fraud auditing detect drift.
    balance_after     integer     not null check (balance_after >= 0),
    -- Free-text justification (admin types into the modal, AI engine writes a
    -- short reason like "ai_chat:7-turns"). Indexed only for prefix-search if
    -- a future need arises.
    reason            text,
    -- Anything structured. For admin grants we stash { request_id, source }.
    -- For Stripe purchases we'll stash { stripe_session_id, amount_cents }.
    metadata          jsonb       not null default '{}'::jsonb,
    -- Who performed the change.
    --   - For admin_grant: the admin's auth.users.id.
    --   - For spend_*    : the same as user_id (self-spend).
    --   - For purchase   : null (system, the webhook).
    actor_user_id     uuid        references auth.users(id) on delete set null,
    -- API request id this row originated from. Lets us cross-reference an
    -- admin grant against the symp_api_access_log entry.
    request_id        text,
    created_at        timestamptz not null default now()
);

-- Hot path: user-facing transaction history list.
create index if not exists idx_credit_tx_user_recent
    on public.symp_credit_transactions (user_id, created_at desc);
-- Reporting / cohorting by transaction kind.
create index if not exists idx_credit_tx_type
    on public.symp_credit_transactions (transaction_type, created_at desc);
-- Audit lookup ("show me everything admin X did").
create index if not exists idx_credit_tx_actor
    on public.symp_credit_transactions (actor_user_id, created_at desc)
    where actor_user_id is not null;

-- ── 3. Atomic adjuster — the ONLY way to mutate a wallet ───────────────────
--
-- All callers (admin grants, AI spend, Stripe webhooks, refunds) go through
-- this function. It:
--
--   1. Takes a row lock on the wallet (creating it if missing).
--   2. Recomputes balance.
--   3. Refuses to go negative — raises with code 'P0001' so the API layer
--      can return 402 PAYMENT_REQUIRED cleanly.
--   4. Writes the ledger row with balance_after = new balance.
--   5. Updates lifetime_granted / lifetime_spent depending on sign.
--   6. Returns the resulting wallet snapshot as JSON.
--
-- SECURITY DEFINER + revoke-from-public + grant-to-service_role means only
-- the Symp.ai service-role layer can call this — browsers cannot.
create or replace function public.adjust_credits(
    p_user_id           uuid,
    p_amount            integer,
    p_transaction_type  text,
    p_reason            text     default null,
    p_metadata          jsonb    default '{}'::jsonb,
    p_actor_user_id     uuid     default null,
    p_request_id        text     default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_new_balance      integer;
    v_lifetime_granted bigint;
    v_lifetime_spent   bigint;
    v_tx_id            uuid;
begin
    if p_user_id is null then
        raise exception 'user_id is required' using errcode = '22023';
    end if;
    if p_amount = 0 then
        raise exception 'amount must be non-zero' using errcode = '22023';
    end if;

    -- Make sure the wallet row exists, then lock it.
    insert into public.symp_credit_wallets (user_id)
    values (p_user_id)
    on conflict (user_id) do nothing;

    -- Lock + read current state.
    select current_credits, lifetime_granted, lifetime_spent
      into v_new_balance, v_lifetime_granted, v_lifetime_spent
      from public.symp_credit_wallets
     where user_id = p_user_id
       for update;

    v_new_balance := v_new_balance + p_amount;

    if v_new_balance < 0 then
        -- Custom SQLSTATE so the API layer can map to a clean error code.
        raise exception 'INSUFFICIENT_CREDITS: balance would go negative'
            using errcode = 'P0001';
    end if;

    if p_amount > 0 then
        v_lifetime_granted := v_lifetime_granted + p_amount;
    else
        v_lifetime_spent := v_lifetime_spent + abs(p_amount);
    end if;

    -- Write the ledger FIRST so we always have a receipt even if the wallet
    -- update fails (in practice they're in the same txn, but order matters
    -- if a future trigger ever fires on wallet update).
    insert into public.symp_credit_transactions
        (user_id, amount, transaction_type, balance_after,
         reason, metadata, actor_user_id, request_id)
    values
        (p_user_id, p_amount, p_transaction_type, v_new_balance,
         p_reason, coalesce(p_metadata, '{}'::jsonb), p_actor_user_id, p_request_id)
    returning id into v_tx_id;

    update public.symp_credit_wallets
       set current_credits  = v_new_balance,
           lifetime_granted = v_lifetime_granted,
           lifetime_spent   = v_lifetime_spent,
           updated_at       = now()
     where user_id = p_user_id;

    return jsonb_build_object(
        'transaction_id',    v_tx_id,
        'user_id',           p_user_id,
        'amount',            p_amount,
        'transaction_type',  p_transaction_type,
        'balance_after',     v_new_balance,
        'lifetime_granted',  v_lifetime_granted,
        'lifetime_spent',    v_lifetime_spent
    );
end;
$$;

-- Lock the function down: only the service-role / definer can call it.
revoke all on function public.adjust_credits(
    uuid, integer, text, text, jsonb, uuid, text
) from public;
revoke all on function public.adjust_credits(
    uuid, integer, text, text, jsonb, uuid, text
) from anon, authenticated;

-- ── 4. RLS — browsers see ONLY their own rows ──────────────────────────────
alter table public.symp_credit_wallets       enable row level security;
alter table public.symp_credit_transactions  enable row level security;

-- Owner-read on wallets.
drop policy if exists wallets_self_select on public.symp_credit_wallets;
create policy wallets_self_select
    on public.symp_credit_wallets
    for select
    using (user_id = auth.uid());

-- Admin-read on wallets (admins can see any wallet via the dashboard).
drop policy if exists wallets_admin_select on public.symp_credit_wallets;
create policy wallets_admin_select
    on public.symp_credit_wallets
    for select
    using (
        exists (
            select 1 from public.profiles p
             where p.id = auth.uid()
               and p.role = 'admin'
        )
    );

-- Owner-read on ledger.
drop policy if exists tx_self_select on public.symp_credit_transactions;
create policy tx_self_select
    on public.symp_credit_transactions
    for select
    using (user_id = auth.uid());

-- Admin-read on ledger.
drop policy if exists tx_admin_select on public.symp_credit_transactions;
create policy tx_admin_select
    on public.symp_credit_transactions
    for select
    using (
        exists (
            select 1 from public.profiles p
             where p.id = auth.uid()
               and p.role = 'admin'
        )
    );

-- No INSERT/UPDATE/DELETE policies for browsers. Mutations are forced through
-- the SECURITY DEFINER RPC, which the service-role layer calls from
-- /api/symp/v1/credits/* and /api/symp/v1/admin/credits/*.

-- ── 5. Convenience view — current wallet + last 50 movements ───────────────
-- Used by the admin "user detail" panel to one-shot read everything it needs.
create or replace view public.symp_credit_account_summary as
    select
        w.user_id,
        w.current_credits,
        w.lifetime_granted,
        w.lifetime_spent,
        w.updated_at  as wallet_updated_at,
        coalesce((
            select jsonb_agg(t order by t.created_at desc)
              from (
                  select tx.id, tx.amount, tx.transaction_type, tx.balance_after,
                         tx.reason, tx.metadata, tx.actor_user_id, tx.created_at
                    from public.symp_credit_transactions tx
                   where tx.user_id = w.user_id
                   order by tx.created_at desc
                   limit 50
              ) t
        ), '[]'::jsonb) as recent_transactions
      from public.symp_credit_wallets w;

commit;
