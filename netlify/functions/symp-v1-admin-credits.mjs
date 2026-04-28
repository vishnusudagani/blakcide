// Admin-only credit operations.
//
//   POST /api/symp/v1/admin/credits/grant
//        body { target_user_id, amount, reason, transaction_type? }
//        amount may be negative (clawback). Resulting balance must stay ≥ 0.
//
//   GET  /api/symp/v1/admin/credits/lookup?user_id=…
//        wallet snapshot + last 50 ledger rows.
//
//   GET  /api/symp/v1/admin/users/search?q=…
//        type-ahead user picker (excludes admins). Each row carries a
//        current_credits decoration for the dashboard list.
//
// Auth model:
//   The Blaksyd proxy stamps body.user_id (POST) and ?user_id= (GET) with the
//   admin's authenticated id. We re-verify `profiles.role === 'admin'` here
//   so that even if the proxy ever has a regression, a non-admin caller
//   cannot mutate someone else's wallet. Defence in depth.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError, readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import {
    isAdmin, adjustCredits, searchUsersForAdmin, getAccountSummaryForAdmin,
    CreditError,
} from '../../symp-core/lib/credits.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, CREDIT_TRANSACTION_TYPES } = SympContract;

// Cap a single admin grant so a stray decimal doesn't blow up someone's
// wallet to absurd numbers. 10k credits per single tx is plenty for any real
// admin gesture; if a higher number is genuinely needed, do it in batches.
const MAX_ABS_GRANT = 10_000;

async function requireAdmin({ adminId, requestId, endpoint, t0 }) {
    if (!adminId) {
        logAccess({ requestId, endpoint, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return jsonError(ERROR_CODES.INVALID_API_KEY, 'authenticated user_id missing', 401, requestId);
    }
    const ok = await isAdmin(adminId).catch(() => false);
    if (!ok) {
        logAccess({ requestId, endpoint, userId: adminId, statusCode: 403, latencyMs: Date.now() - t0, errorCode: 'FORBIDDEN' });
        return jsonError(ERROR_CODES.FORBIDDEN, 'admin role required', 403, requestId);
    }
    return null;
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();

    const t0        = Date.now();
    const requestId = getRequestId(req);
    const url       = new URL(req.url);
    const path      = url.pathname;

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: path, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    // ── POST /admin/credits/grant ────────────────────────────────────────
    if (req.method === 'POST' && path.endsWith('/admin/credits/grant')) {
        const parsed = await readJson(req);
        if (!parsed.ok) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
        }
        const {
            user_id:         adminId,           // proxy-stamped from JWT
            target_user_id:  targetId,
            amount,
            reason,
            transaction_type: txType = 'admin_grant',
        } = parsed.data || {};

        const guard = await requireAdmin({ adminId, requestId, endpoint: path, t0 });
        if (guard) return guard;

        if (!targetId) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'target_user_id required', 400, requestId);
        }
        const amt = Number(amount);
        if (!Number.isInteger(amt) || amt === 0) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'amount must be a non-zero integer', 400, requestId);
        }
        if (Math.abs(amt) > MAX_ABS_GRANT) {
            return jsonError(ERROR_CODES.BAD_REQUEST, `|amount| must be ≤ ${MAX_ABS_GRANT} per call`, 400, requestId);
        }
        if (!CREDIT_TRANSACTION_TYPES.includes(txType)) {
            return jsonError(ERROR_CODES.BAD_REQUEST, `invalid transaction_type '${txType}'`, 400, requestId);
        }
        if (typeof reason !== 'string' || reason.trim().length < 3) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'reason (≥ 3 chars) required for admin grants', 400, requestId);
        }

        let result;
        try {
            result = await adjustCredits({
                userId:          targetId,
                amount:          amt,
                transactionType: txType,
                reason:          reason.trim().slice(0, 500),
                metadata:        { source: 'admin_dashboard' },
                actorUserId:     adminId,
                requestId,
            });
        } catch (e) {
            if (e instanceof CreditError) {
                logAccess({
                    requestId, endpoint: path, userId: adminId,
                    statusCode: e.status, latencyMs: Date.now() - t0,
                    errorCode:  e.code,
                });
                return jsonError(e.code, e.message, e.status, requestId);
            }
            logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
            return jsonError(ERROR_CODES.INTERNAL_ERROR, `grant failed: ${e.message || e}`, 500, requestId);
        }

        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ result }, requestId);
    }

    // ── GET /admin/credits/lookup ────────────────────────────────────────
    if (req.method === 'GET' && path.endsWith('/admin/credits/lookup')) {
        const adminId = url.searchParams.get('user_id');     // proxy-stamped
        const target  = url.searchParams.get('target_user_id');
        const guard   = await requireAdmin({ adminId, requestId, endpoint: path, t0 });
        if (guard) return guard;
        if (!target) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'target_user_id required', 400, requestId);
        }
        let summary;
        try { summary = await getAccountSummaryForAdmin(target, { historyLimit: 50 }); }
        catch (e) {
            logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
            return jsonError(ERROR_CODES.INTERNAL_ERROR, `lookup failed: ${e.message || e}`, 500, requestId);
        }
        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ target_user_id: target, ...summary }, requestId);
    }

    // ── GET /admin/users/search ──────────────────────────────────────────
    if (req.method === 'GET' && path.endsWith('/admin/users/search')) {
        const adminId = url.searchParams.get('user_id');     // proxy-stamped
        const q       = url.searchParams.get('q') || '';
        const limit   = Number(url.searchParams.get('limit')) || 12;
        const guard   = await requireAdmin({ adminId, requestId, endpoint: path, t0 });
        if (guard) return guard;
        let users;
        try { users = await searchUsersForAdmin(q, { limit }); }
        catch (e) {
            logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
            return jsonError(ERROR_CODES.INTERNAL_ERROR, `search failed: ${e.message || e}`, 500, requestId);
        }
        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ users }, requestId);
    }

    return new Response('Method Not Allowed', { status: 405 });
};

export const config = {
    path: [
        '/api/symp/v1/admin/credits/grant',
        '/api/symp/v1/admin/credits/lookup',
        '/api/symp/v1/admin/users/search',
    ],
};
