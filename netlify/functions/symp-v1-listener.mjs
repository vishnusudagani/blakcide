// Listener Co-Pilot endpoints:
//
//   POST /api/symp/v1/listener/brief
//        body: { user_id, listener_id, connect_session_id, force? }
//        returns: { brief }   — pre-session JSON brief, idempotent
//
//   POST /api/symp/v1/listener/vibe-check
//        body: { user_id, recent_turns:[{speaker,text}] }
//        returns: { vibe_check, priority, suggestion, language_lane }
//
// We use POST for both (briefs + vibe-checks) so listener_id and the recent
// turns array can be passed cleanly without query-string limits.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, jsonSuccess, readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { buildBrief, buildVibeCheck } from '../../symp-core/lib/whisperer.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);
    const url = new URL(req.url);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: url.pathname, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
    const body = parsed.data || {};

    if (url.pathname.endsWith('/listener/brief')) {
        const { user_id, listener_id, connect_session_id, force = false } = body;
        if (!user_id || !listener_id || !connect_session_id) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'user_id, listener_id, connect_session_id required', 400, requestId);
        }
        try {
            const brief = await buildBrief({ userId: user_id, listenerId: listener_id, connectSessionId: connect_session_id, force });
            logAccess({ requestId, endpoint: url.pathname, userId: user_id, statusCode: 200, latencyMs: Date.now() - t0 });
            return jsonSuccess({ brief }, requestId);
        } catch (e) {
            logAccess({ requestId, endpoint: url.pathname, userId: user_id, statusCode: 502, latencyMs: Date.now() - t0, errorCode: 'UPSTREAM_FAILED' });
            return jsonError(ERROR_CODES.UPSTREAM_FAILED, String(e.message || e), 502, requestId);
        }
    }

    if (url.pathname.endsWith('/listener/vibe-check')) {
        const { user_id, recent_turns } = body;
        if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        if (!Array.isArray(recent_turns)) return jsonError(ERROR_CODES.BAD_REQUEST, 'recent_turns[] required', 400, requestId);

        const vc = await buildVibeCheck({ userId: user_id, recentTurns: recent_turns });
        if (!vc) return jsonSuccess({ vibe_check: 'steady', priority: 'low', suggestion: '', language_lane: 'en' }, requestId);
        logAccess({ requestId, endpoint: url.pathname, userId: user_id, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess(vc, requestId);
    }

    return new Response('Not Found', { status: 404 });
};

export const config = { path: ['/api/symp/v1/listener/brief', '/api/symp/v1/listener/vibe-check'] };
