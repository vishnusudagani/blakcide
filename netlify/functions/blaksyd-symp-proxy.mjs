// Blaksyd → Symp.ai secure proxy.
//
// Browser calls   /api/blaksyd/symp/<endpoint>   with  Authorization: Bearer <supabase-jwt>.
// This function:
//   1. Verifies the JWT (local HMAC preferred, /auth/v1/user fallback).
//   2. Derives the authoritative user_id from the JWT claims.
//   3. Injects  x-symp-api-key  (never seen by the browser).
//   4. Overrides any user_id in the request payload with the authenticated one
//      so a compromised client cannot act on behalf of another user.
//   5. Forwards to  /api/symp/v1/<endpoint>  on the same host, piping the
//      response body back — SSE streaming preserved.
//
// Security invariants:
//   - Browser NEVER holds SYMP_API_KEY.
//   - The only user_id Symp.ai sees is the one from the verified JWT.
//   - Unauthenticated or bad-token requests get 401 without touching Symp.ai.

import { verifySupabaseJwt, extractBearer } from '../../symp-core/lib/auth.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { SYMP_API_BASE, BLAKSYD_PROXY_BASE, SYMP_API_KEY_HEADER, SYMP_REQUEST_ID_HEADER } = SympContract;

const SYMP_API_KEY = process.env.SYMP_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Per-user rate limits (cost-DoS backstop), by endpoint → [bucket, perMin, perHour].
// Cheap/read endpoints are unlimited. Enforced via the check_rate_limit RPC.
const RATE_LIMITS = {
    chat: ['ai_chat', 30, 300], voice: ['ai_chat', 30, 300], 'diagnostic/turn': ['ai_chat', 30, 300],
    vision: ['ai_vision', 15, 120], transcribe: ['ai_transcribe', 20, 200],
    tts: ['ai_misc', 40, 400], title: ['ai_misc', 40, 400], 'proactive-checkin': ['ai_misc', 40, 400],
    'persona-generate': ['ai_misc', 30, 200],
};
const MAX_BODY_BYTES = 30 * 1024 * 1024;   // 30 MB — audio upload ceiling
const MAX_JSON_BYTES = 700 * 1024;         // ~700 KB JSON ceiling (post-cap)
const MAX_MESSAGES   = 60;                  // keep only the last N turns
const MAX_MSG_CHARS  = 8000;               // per-message content cap

// CORS — this endpoint IS browser-facing so we need real CORS handling.
const CORS = {
    'Access-Control-Allow-Origin':      '*',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, x-symp-request-id',
    'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers':    SYMP_REQUEST_ID_HEADER,
};

function jsonError(code, message, status, requestId) {
    return new Response(
        JSON.stringify({ ok: false, error: { code, message }, request_id: requestId || null }),
        {
            status,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        }
    );
}

export default async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (!SYMP_API_KEY) {
        return jsonError('INTERNAL_ERROR', 'Proxy misconfigured: SYMP_API_KEY not set', 500);
    }

    // Guard against oversized uploads before buffering anything (OOM / cost).
    const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
        return jsonError('BAD_REQUEST', 'Request body too large', 413);
    }

    // ── 1. Resolve the target Symp.ai endpoint from the splat path ───────
    const incoming = new URL(req.url);
    if (!incoming.pathname.startsWith(BLAKSYD_PROXY_BASE + '/')) {
        return jsonError('BAD_REQUEST', 'Unexpected proxy path', 400);
    }
    const splat = incoming.pathname.slice(BLAKSYD_PROXY_BASE.length + 1); // e.g. "chat" or "session/ingest"
    if (!splat) return jsonError('BAD_REQUEST', 'Missing target endpoint', 400);

    // Allowlist — only expose endpoints Blaksyd is meant to hit. Admin routes
    // (vault/:user_id) and raw whisper WS are deliberately excluded.
    const ALLOWED = new Set([
        'health', 'chat', 'voice', 'title', 'transcribe', 'vision', 'tts', 'persona-generate',
        'session/ingest', 'analyse/run', 'copilot/hint',
        'proactive-checkin',
        // Unified Soul:
        'vibe', 'vibe/event',
        'personas', 'persona/state', 'persona/swap',
        'listener/brief', 'listener/vibe-check',
        'diagnostic/turn', 'diagnostic/peek',
        // Nexus (community module):
        'nexus/communities', 'nexus/communities/by-slug',
        'nexus/communities/join', 'nexus/communities/leave',
        'nexus/feed', 'nexus/posts', 'nexus/comments',
        'nexus/impacts', 'nexus/me/impact-stats',
        // Credits — user-facing wallet read + Stripe stub:
        'credits/balance', 'credits/transactions', 'credits/checkout/start',
        // Credits — admin (handler enforces profiles.role='admin' itself):
        'admin/credits/grant', 'admin/credits/lookup', 'admin/users/search',
        // Admin dashboard feeds (all admin-role-gated server-side):
        'admin/overview', 'admin/users/list', 'admin/users/detail',
        'admin/symp-status', 'admin/recent-activity',
        // action-loop/run intentionally omitted — CRON-only, never browser
    ]);
    if (!ALLOWED.has(splat)) {
        return jsonError('BAD_REQUEST', `Endpoint '${splat}' not exposed via proxy`, 404);
    }

    // ── 2. Verify Supabase JWT ───────────────────────────────────────────
    const bearer = extractBearer(req.headers.get('authorization'));
    if (!bearer) return jsonError('INVALID_API_KEY', 'Missing Authorization: Bearer <supabase-jwt>', 401);

    const verified = await verifySupabaseJwt(bearer);
    if (!verified.ok) {
        return jsonError('INVALID_API_KEY', `JWT verification failed: ${verified.reason}`, 401);
    }
    const authUserId = verified.user_id;

    // ── 2b. Per-user rate limit on billed AI endpoints ───────────────────
    // Fail OPEN: a limiter hiccup (network/RPC error) must never take down chat.
    const rl = RATE_LIMITS[splat];
    if (rl && SUPABASE_URL) {
        try {
            const rlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_rate_limit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${bearer}`,
                },
                body: JSON.stringify({ p_bucket: rl[0], p_per_min: rl[1], p_per_hour: rl[2] }),
            });
            if (rlRes.ok && (await rlRes.json()) === false) {
                return jsonError('RATE_LIMITED', 'You’re going a bit fast — give it a moment and try again.', 429);
            }
        } catch (_) { /* fail open */ }
    }

    // ── 3. Build forwarded request ───────────────────────────────────────
    // For GET requests, always stamp user_id from the verified JWT. This
    // both overrides any client-supplied value (so a compromised client
    // cannot read someone else's data) and adds it when absent (so handlers
    // that need it but didn't have it in the query receive it consistently).
    const fwdSearch = new URLSearchParams(incoming.search || '');
    fwdSearch.set('user_id', authUserId);
    const fwdQs = fwdSearch.toString();
    const targetUrl = `${incoming.origin}${SYMP_API_BASE}/${splat}${fwdQs ? '?' + fwdQs : ''}`;

    // Preserve request-id if caller sent one, else create
    const requestId = req.headers.get(SYMP_REQUEST_ID_HEADER)
        || (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36));

    const forwardHeaders = {
        [SYMP_API_KEY_HEADER]:     SYMP_API_KEY,
        [SYMP_REQUEST_ID_HEADER]:  requestId,
    };

    let forwardBody = undefined;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        const contentType = req.headers.get('content-type') || 'application/json';
        forwardHeaders['Content-Type'] = contentType;

        if (contentType.includes('application/json')) {
            // Parse, override user_id, cap inputs, re-stringify.
            let body = {};
            try { body = await req.json(); } catch (_) { body = {}; }
            body.user_id = authUserId;  // authoritative override
            // Input caps — bound prompt size (cost amplification + injection surface).
            if (Array.isArray(body.messages)) {
                if (body.messages.length > MAX_MESSAGES) body.messages = body.messages.slice(-MAX_MESSAGES);
                for (const m of body.messages) {
                    if (m && typeof m.content === 'string' && m.content.length > MAX_MSG_CHARS) m.content = m.content.slice(0, MAX_MSG_CHARS);
                }
            }
            forwardBody  = JSON.stringify(body);
            if (forwardBody.length > MAX_JSON_BYTES) return jsonError('BAD_REQUEST', 'Payload too large', 413, requestId);
        } else {
            // Pass through raw (e.g. multipart). Note: we cannot override
            // user_id in non-JSON bodies, so non-JSON endpoints MUST derive
            // user_id from other mechanisms or be added to a JSON-only list.
            forwardBody = await req.text();
        }
    }

    // ── 4. Forward and pipe response back ────────────────────────────────
    let upstream;
    try {
        upstream = await fetch(targetUrl, {
            method:  req.method,
            headers: forwardHeaders,
            body:    forwardBody,
        });
    } catch (e) {
        return jsonError('UPSTREAM_FAILED', `Proxy fetch failed: ${e.message || e}`, 502, requestId);
    }

    // Pipe body straight through — SSE streams keep streaming.
    const responseHeaders = {
        ...CORS,
        [SYMP_REQUEST_ID_HEADER]: requestId,
    };
    const contentType = upstream.headers.get('content-type');
    if (contentType) responseHeaders['Content-Type'] = contentType;
    const cacheControl = upstream.headers.get('cache-control');
    if (cacheControl) responseHeaders['Cache-Control'] = cacheControl;

    return new Response(upstream.body, {
        status:  upstream.status,
        headers: responseHeaders,
    });
};

export const config = { path: '/api/blaksyd/symp/*' };
