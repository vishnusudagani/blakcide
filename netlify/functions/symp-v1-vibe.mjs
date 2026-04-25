// GET  /api/symp/v1/vibe?user_id=…    (admin / internal — proxy passes user_id from JWT)
// POST /api/symp/v1/vibe/event        (admin / internal — pushes a delta)
//
// Read returns the current symp_vibe_state row (or a zero-state object).
// Write triggers the classifier + appends an event + recomputes state.
//
// The browser proxy already overrides user_id from the JWT, so handlers trust
// the user_id in the body / query.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, jsonSuccess, readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { getVibe, recordEvent } from '../../symp-core/lib/vibe-tracker.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    const t0 = Date.now();
    const requestId = getRequestId(req);
    const url = new URL(req.url);
    const isEventPath = url.pathname.endsWith('/event');

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: url.pathname, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    if (req.method === 'GET') {
        const userId = url.searchParams.get('user_id');
        if (!userId) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        const vibe = await getVibe(userId);
        logAccess({ requestId, endpoint: url.pathname, userId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess(vibe, requestId);
    }

    if (req.method === 'POST' && isEventPath) {
        const parsed = await readJson(req);
        if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
        const { user_id, source, source_session_id, evidence } = parsed.data || {};
        if (!user_id)   return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        if (!source || !evidence) return jsonError(ERROR_CODES.BAD_REQUEST, 'source + evidence required', 400, requestId);

        await recordEvent(user_id, { source, sourceSessionId: source_session_id, evidence });
        const next = await getVibe(user_id);
        logAccess({ requestId, endpoint: url.pathname, userId: user_id, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess(next, requestId);
    }

    return new Response('Method Not Allowed', { status: 405 });
};

export const config = { path: ['/api/symp/v1/vibe', '/api/symp/v1/vibe/event'] };
