// GET  /api/symp/v1/credits/balance        — caller's wallet snapshot
// GET  /api/symp/v1/credits/transactions   — caller's recent ledger rows
// POST /api/symp/v1/credits/checkout/start — Stripe stub (Phase 2 swap point)
//
// All three endpoints rely on the proxy stamping `user_id` (query param for
// GET, body field for POST) from the verified Supabase JWT. That means the
// caller can ONLY ever read their own wallet — never someone else's.
//
// Stripe swap point:
//   The /credits/checkout/start handler is intentionally a stub. Phase 2 will
//   replace its body with a Stripe Checkout Session creator. The browser
//   contract (request shape, response shape, where it's wired in the profile
//   modal) is finalised here so the swap doesn't ripple through the UI.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { getWallet, listTransactions } from '../../symp-core/lib/credits.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

// ─────────────────────────────────────────────────────────────────────────
// 🟡 STRIPE SWAP POINT — Phase 2 implementation goes inside this function
// ─────────────────────────────────────────────────────────────────────────
// Currently returns 501 NOT_IMPLEMENTED so the profile modal shows a
// placeholder. The browser contract is finalised: when this returns
//   { ok:true, data:{ checkout_url } }
// the client redirects to Stripe automatically (see profile-manager.js:
// `window.requestCheckoutSession`).
//
// Phase 2 implementation outline:
//   1. Define SKU map at module top:
//        const STRIPE_SKUS = {
//            100:   process.env.STRIPE_PRICE_100,
//            500:   process.env.STRIPE_PRICE_500,
//            2500:  process.env.STRIPE_PRICE_2500,
//            10000: process.env.STRIPE_PRICE_10000,
//        };
//   2. import Stripe from 'stripe' (add to package.json) and
//        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
//   3. Inside handleCheckoutStart:
//        const credits = Number(body.credits);
//        const priceId = STRIPE_SKUS[credits];
//        if (!priceId) return { ok:false, code:'BAD_REQUEST', status:400, message:'invalid credits SKU' };
//        const session = await stripe.checkout.sessions.create({
//            mode:                'payment',
//            line_items:          [{ price: priceId, quantity: 1 }],
//            success_url:         'https://blakcide.com/profile?credits=success&sid={CHECKOUT_SESSION_ID}',
//            cancel_url:          'https://blakcide.com/profile?credits=cancel',
//            client_reference_id: userId,
//            metadata:            { user_id: userId, credits: String(credits) },
//        });
//        return { ok:true, status:200, data:{ checkout_url: session.url } };
//   4. Add netlify/functions/stripe-webhook.mjs to listen for
//      `checkout.session.completed`, verify Stripe-Signature, and call
//      adjustCredits({ userId, amount: credits, transactionType: 'purchase',
//        reason: 'Stripe checkout', metadata: { stripe_session_id, ... } }).
//
// Required env vars (none currently set on Netlify — `netlify env:list` shows
// they need to be added before flipping the swap):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   STRIPE_PRICE_100, STRIPE_PRICE_500, STRIPE_PRICE_2500, STRIPE_PRICE_10000
// ─────────────────────────────────────────────────────────────────────────
async function handleCheckoutStart(_userId, _body) {
    return {
        ok:      false,
        code:    'NOT_IMPLEMENTED',
        message: 'Stripe checkout is not enabled yet — credits are admin-granted in this phase.',
        status:  501,
    };
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

    // ── GET /credits/balance ─────────────────────────────────────────────
    if (req.method === 'GET' && path.endsWith('/credits/balance')) {
        const userId = url.searchParams.get('user_id');
        if (!userId) {
            logAccess({ requestId, endpoint: path, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'MISSING_USER_ID' });
            return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        }
        let wallet;
        try { wallet = await getWallet(userId); }
        catch (e) {
            logAccess({ requestId, endpoint: path, userId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
            return jsonError(ERROR_CODES.INTERNAL_ERROR, `wallet read failed: ${e.message || e}`, 500, requestId);
        }
        logAccess({ requestId, endpoint: path, userId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ wallet }, requestId);
    }

    // ── GET /credits/transactions ────────────────────────────────────────
    if (req.method === 'GET' && path.endsWith('/credits/transactions')) {
        const userId = url.searchParams.get('user_id');
        const limit  = Number(url.searchParams.get('limit')) || 25;
        const before = url.searchParams.get('before') || undefined;
        if (!userId) {
            logAccess({ requestId, endpoint: path, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'MISSING_USER_ID' });
            return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        }
        let rows;
        try { rows = await listTransactions(userId, { limit, before }); }
        catch (e) {
            logAccess({ requestId, endpoint: path, userId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
            return jsonError(ERROR_CODES.INTERNAL_ERROR, `tx read failed: ${e.message || e}`, 500, requestId);
        }
        logAccess({ requestId, endpoint: path, userId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ transactions: rows }, requestId);
    }

    // ── POST /credits/checkout/start (Stripe stub) ───────────────────────
    if (req.method === 'POST' && path.endsWith('/credits/checkout/start')) {
        let body = {};
        try { body = await req.json(); } catch (_) { body = {}; }
        const userId = body?.user_id;
        if (!userId) {
            return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        }
        const result = await handleCheckoutStart(userId, body);
        logAccess({
            requestId, endpoint: path, userId,
            statusCode: result.status, latencyMs: Date.now() - t0,
            errorCode:  result.ok ? null : (result.code || 'NOT_IMPLEMENTED'),
        });
        if (result.ok) return jsonSuccess(result.data || {}, requestId);
        return jsonError(result.code || 'NOT_IMPLEMENTED', result.message, result.status || 501, requestId);
    }

    return new Response('Method Not Allowed', { status: 405 });
};

export const config = {
    path: [
        '/api/symp/v1/credits/balance',
        '/api/symp/v1/credits/transactions',
        '/api/symp/v1/credits/checkout/start',
    ],
};
