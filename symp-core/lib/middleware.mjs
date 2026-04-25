// Symp.ai shared middleware — auth, envelope, request IDs, access logging.
// Imported by every netlify/functions/symp-v1-*.mjs handler.

import crypto from 'node:crypto';
import SympContract from '../contract/endpoints.js';

const { SYMP_API_KEY_HEADER, SYMP_REQUEST_ID_HEADER, ERROR_CODES } = SympContract;

const SYMP_API_KEY              = process.env.SYMP_API_KEY              || '';
const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Permissive CORS — Symp.ai is called server-to-server in production, but we allow
// same-origin browser calls during dev. Lock this down in Step 5 hardening.
const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': `Content-Type, ${SYMP_API_KEY_HEADER}, ${SYMP_REQUEST_ID_HEADER}`,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function corsPreflight() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function getRequestId(req) {
    return req.headers.get(SYMP_REQUEST_ID_HEADER) || crypto.randomUUID();
}

// Returns { ok:true } or { ok:false, response }. Caller short-circuits on !ok.
export function validateApiKey(req, requestId) {
    if (!SYMP_API_KEY) {
        return {
            ok: false,
            response: jsonError(ERROR_CODES.INTERNAL_ERROR, 'SYMP_API_KEY not configured on server', 500, requestId),
        };
    }
    const provided = req.headers.get(SYMP_API_KEY_HEADER);
    if (!provided || provided !== SYMP_API_KEY) {
        return {
            ok: false,
            response: jsonError(ERROR_CODES.INVALID_API_KEY, 'Missing or invalid API key', 401, requestId),
        };
    }
    return { ok: true };
}

export function jsonSuccess(data, requestId, status = 200) {
    return new Response(JSON.stringify({ ok: true, data, request_id: requestId }), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            [SYMP_REQUEST_ID_HEADER]: requestId,
        },
    });
}

export function jsonError(code, message, status, requestId) {
    return new Response(JSON.stringify({ ok: false, error: { code, message }, request_id: requestId }), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            [SYMP_REQUEST_ID_HEADER]: requestId,
        },
    });
}

export async function readJson(req) {
    try {
        const data = await req.json();
        return { ok: true, data };
    } catch (e) {
        return { ok: false, error: e.message || 'Invalid JSON' };
    }
}

// Fire-and-forget access log. Noops silently if SUPABASE env missing or the
// symp_api_access_log table doesn't exist (e.g. user skipped that migration).
// Never throws, never awaited by handlers.
export function logAccess({ requestId, endpoint, userId = null, statusCode, latencyMs, errorCode = null }) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    const body = JSON.stringify({
        request_id:  requestId,
        endpoint,
        user_id:     userId,
        status_code: statusCode,
        latency_ms:  latencyMs,
        error_code:  errorCode,
    });
    fetch(`${SUPABASE_URL}/rest/v1/symp_api_access_log`, {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'apikey':        SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Prefer':        'return=minimal',
        },
        body,
    }).catch(() => { /* best-effort; swallow to protect request path */ });
}

export { CORS_HEADERS };
