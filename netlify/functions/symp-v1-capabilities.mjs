// GET /api/symp/v1/admin/capabilities — the platform "control panel".
//
// Returns the full capability registry resolved against the live Netlify
// runtime: for each capability, whether it is enabled and (if not) the NAMES
// of the env vars still missing. NEVER returns a secret value — only presence.
// Admin-role enforced (proxy stamps user_id from JWT; we re-verify the role).
//
// This is the canonical answer to "what is wired up and what does each gap
// still need" — it stays correct automatically as keys are added.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { isAdmin } from '../../symp-core/lib/credits.mjs';
import { capabilities, capabilitySummary } from '../../symp-core/lib/capabilities.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

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
    if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

    const adminId = url.searchParams.get('user_id'); // proxy-stamped from JWT
    if (!adminId) {
        logAccess({ requestId, endpoint: path, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return jsonError(ERROR_CODES.INVALID_API_KEY, 'authenticated user_id missing', 401, requestId);
    }
    const ok = await isAdmin(adminId).catch(() => false);
    if (!ok) {
        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 403, latencyMs: Date.now() - t0, errorCode: 'FORBIDDEN' });
        return jsonError(ERROR_CODES.FORBIDDEN, 'admin role required', 403, requestId);
    }

    try {
        const payload = {
            summary:      capabilitySummary(),
            capabilities: capabilities(), // {id,group,label,unlocks,where,enabled,missing[]}
            note:         'Probed from the Netlify runtime. Capabilities marked "Supabase Edge" / "Cloud Run" may also need the key set in that runtime to fully activate.',
            generated_at: new Date().toISOString(),
        };
        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess(payload, requestId);
    } catch (e) {
        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `capabilities endpoint failed: ${e.message || e}`, 500, requestId);
    }
};

export const config = { path: '/api/symp/v1/admin/capabilities' };
