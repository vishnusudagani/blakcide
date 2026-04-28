// Credit-system helpers — wallet, ledger, atomic adjuster.
//
// All wallet mutations go through `adjustCredits()`, which calls the
// `adjust_credits()` SECURITY DEFINER RPC defined in
// /supabase/migrations/20260428_credits.sql. The RPC takes the row lock,
// refuses to go negative, writes the ledger row, and returns the resulting
// balance — so we cannot accidentally race a spend against an admin grant.
//
// This module is server-only (uses SUPABASE_SERVICE_ROLE_KEY). Never import
// it from the browser bundle. Browsers reach the wallet through the Symp.ai
// API at /api/symp/v1/credits/* via the Blaksyd proxy.
//
// Modular by design — Phase 2 will swap the "Add Credits" CTA in the user
// profile to call /api/symp/v1/credits/checkout/start (a Stripe Checkout
// session). When that webhook fires, it calls adjustCredits() with type
// 'purchase'. No schema or library changes needed.

const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function requireEnv() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('[symp-core/credits] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    }
}

async function sbFetch(path, { method = 'GET', body, prefer } = {}) {
    requireEnv();
    const headers = {
        'apikey':        SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
    };
    if (prefer) headers['Prefer'] = prefer;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, status: res.status, data };
}

// ── Custom error so the API layer can map cleanly to HTTP codes ────────────
export class CreditError extends Error {
    constructor(code, message, { status = 400, cause } = {}) {
        super(message);
        this.name   = 'CreditError';
        this.code   = code;     // e.g. 'INSUFFICIENT_CREDITS'
        this.status = status;   // suggested HTTP status
        if (cause) this.cause = cause;
    }
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * Fetch a user's wallet row. Returns null if no wallet exists yet (the
 * caller can show a zero-balance state without forcing a write).
 */
export async function getWallet(userId) {
    if (!userId) return null;
    const { ok, data } = await sbFetch(
        `symp_credit_wallets?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=user_id,current_credits,lifetime_granted,lifetime_spent,updated_at`
    );
    if (!ok) return null;
    if (Array.isArray(data) && data[0]) return data[0];
    // No row yet — return a zeroed shape so the UI doesn't have to special-case.
    return {
        user_id:          userId,
        current_credits:  0,
        lifetime_granted: 0,
        lifetime_spent:   0,
        updated_at:       null,
    };
}

/**
 * Recent ledger rows for a user, newest first. `before` is an ISO timestamp
 * for cursor pagination (transaction history "Load more" button).
 */
export async function listTransactions(userId, { limit = 25, before } = {}) {
    if (!userId) return [];
    const cap = Math.max(1, Math.min(200, Number(limit) || 25));
    let path = `symp_credit_transactions?user_id=eq.${encodeURIComponent(userId)}` +
        `&order=created_at.desc&limit=${cap}` +
        `&select=id,amount,transaction_type,balance_after,reason,metadata,actor_user_id,created_at`;
    if (before) path += `&created_at=lt.${encodeURIComponent(before)}`;
    const { ok, data } = await sbFetch(path);
    return (ok && Array.isArray(data)) ? data : [];
}

// ── Mutate via the atomic RPC ──────────────────────────────────────────────

/**
 * Atomic wallet adjustment. Returns
 * { transaction_id, user_id, amount, transaction_type, balance_after,
 *   lifetime_granted, lifetime_spent } on success.
 *
 * Throws CreditError('INSUFFICIENT_CREDITS', ..., { status: 402 }) if the
 * resulting balance would go negative — callers should map that to the
 * 402 PAYMENT_REQUIRED response in the API layer.
 *
 * @param userId          recipient — whose wallet is being moved
 * @param amount          positive int = grant; negative int = spend
 * @param transactionType one of CREDIT_TRANSACTION_TYPES
 * @param reason          short human-readable explanation
 * @param metadata        optional structured info (e.g. stripe_session_id)
 * @param actorUserId     who performed it — admin id for grants, self for spends
 * @param requestId       SYMP_REQUEST_ID_HEADER value for tracing
 */
export async function adjustCredits({
    userId, amount, transactionType,
    reason   = null,
    metadata = {},
    actorUserId = null,
    requestId   = null,
}) {
    if (!userId)                              throw new CreditError('BAD_REQUEST', 'userId is required');
    if (!Number.isInteger(amount) || amount === 0) {
        throw new CreditError('BAD_REQUEST', 'amount must be a non-zero integer');
    }
    if (!transactionType)                     throw new CreditError('BAD_REQUEST', 'transactionType is required');

    const { ok, status, data } = await sbFetch('rpc/adjust_credits', {
        method: 'POST',
        body: {
            p_user_id:           userId,
            p_amount:            amount,
            p_transaction_type:  transactionType,
            p_reason:            reason,
            p_metadata:          metadata || {},
            p_actor_user_id:     actorUserId,
            p_request_id:        requestId,
        },
    });

    if (ok) return data;

    // PostgREST returns the SQLSTATE/code in the error JSON. We map our
    // custom 'P0001' INSUFFICIENT_CREDITS guard to a clean 402 for the API.
    const errCode = (data && (data.code || data.sqlstate)) || '';
    const errMsg  = (data && (data.message || data.hint))  || 'adjust_credits failed';
    if (errCode === 'P0001' || /INSUFFICIENT_CREDITS/i.test(errMsg)) {
        throw new CreditError('INSUFFICIENT_CREDITS', errMsg, { status: 402 });
    }
    throw new CreditError('INTERNAL_ERROR', errMsg, { status: status || 500, cause: data });
}

// ── Admin helpers ──────────────────────────────────────────────────────────

/**
 * Returns true iff the given user has profiles.role = 'admin'.
 * Reused across all admin endpoints — single source of role truth.
 */
export async function isAdmin(userId) {
    if (!userId) return false;
    const { ok, data } = await sbFetch(
        `profiles?id=eq.${encodeURIComponent(userId)}&select=role`
    );
    if (!ok || !Array.isArray(data) || !data[0]) return false;
    return data[0].role === 'admin';
}

/**
 * Type-ahead user search for the admin "Adjust balance" picker. Searches
 * full_name (case-insensitive contains) and the email column on profiles.
 * Excludes admins from the result so the dashboard shows the user-base only.
 *
 * Returns up to `limit` rows of { id, full_name, email, role, current_credits }.
 */
export async function searchUsersForAdmin(query, { limit = 12 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const cap = Math.max(1, Math.min(50, Number(limit) || 12));
    // PostgREST `or` filter — escape commas/parens that would break the syntax.
    const safe = q.replace(/[(),]/g, ' ').slice(0, 80);
    const orFilter = `or=(full_name.ilike.*${encodeURIComponent(safe)}*,email.ilike.*${encodeURIComponent(safe)}*)`;
    const path = `profiles?${orFilter}` +
        `&role=neq.admin` +
        `&select=id,full_name,email,role&limit=${cap}`;
    const { ok, data } = await sbFetch(path);
    const rows = (ok && Array.isArray(data)) ? data : [];
    if (!rows.length) return [];

    // Decorate with current balance — one batched query against wallets.
    const ids = rows.map(r => r.id);
    const inList = ids.map(encodeURIComponent).join(',');
    const wRes = await sbFetch(
        `symp_credit_wallets?user_id=in.(${inList})` +
        `&select=user_id,current_credits`
    );
    const balanceByUser = new Map();
    if (wRes.ok && Array.isArray(wRes.data)) {
        for (const w of wRes.data) balanceByUser.set(w.user_id, w.current_credits);
    }
    return rows.map(r => ({
        id:               r.id,
        full_name:        r.full_name,
        email:            r.email,
        role:             r.role,
        current_credits:  balanceByUser.get(r.id) ?? 0,
    }));
}

/**
 * Admin-side view of one user — wallet snapshot + recent ledger rows.
 * Used to populate the admin "user detail" panel after a search-result click.
 */
export async function getAccountSummaryForAdmin(userId, { historyLimit = 50 } = {}) {
    if (!userId) return null;
    const [wallet, history] = await Promise.all([
        getWallet(userId),
        listTransactions(userId, { limit: historyLimit }),
    ]);
    return { wallet, history };
}
