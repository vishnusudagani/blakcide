// Module 5 — diagnostic endpoints.
//
//   POST /api/symp/v1/diagnostic/turn
//     Body: { user_id, user_text, model_text, was_interrupted?, surface? }
//     Runs analyseTurn() and returns the active corrections. Voice clients
//     call this after each call leg so they can apply VAD overrides.
//
//   GET  /api/symp/v1/diagnostic/peek?user_id=...
//     Returns the currently-pinned corrections without mutating state.
//     Voice clients hit this right before opening a Realtime WS so they can
//     ship the relaxed VAD profile in the first session.update.
//
// Note: state is in-process. For multi-region deploys this is fine — each
// worker self-corrects independently and converges within a few turns.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { analyseTurn, peekVadOverride, buildCorrectionHint }
    from '../../symp-core/lib/diagnostic.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();

    const t0        = Date.now();
    const requestId = getRequestId(req);
    const url       = new URL(req.url);
    const action    = url.pathname.split('/').pop(); // 'turn' or 'peek'

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: `diagnostic/${action}`, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    if (action === 'peek') {
        if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
        const userId = url.searchParams.get('user_id');
        if (!userId) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);

        const data = {
            vad_override:    peekVadOverride(userId),
            correction_hint: buildCorrectionHint(userId) || null,
        };
        logAccess({ requestId, endpoint: 'diagnostic/peek', statusCode: 200, latencyMs: Date.now() - t0, userId });
        return new Response(
            JSON.stringify({ ok: true, data, request_id: requestId }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
        );
    }

    if (action === 'turn') {
        if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        const parsed = await readJson(req);
        if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

        const {
            user_id, user_text = '', model_text = '',
            was_interrupted = false, surface = 'chat',
        } = parsed.data || {};

        if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);

        const result = analyseTurn({
            userId:          user_id,
            userText:        user_text,
            modelText:       model_text,
            wasInterrupted:  !!was_interrupted,
            surface:         surface === 'voice' ? 'voice' : 'chat',
        });

        const data = {
            signals:         result.signals,
            vad_override:    peekVadOverride(user_id),
            correction_hint: buildCorrectionHint(user_id) || null,
        };
        logAccess({ requestId, endpoint: 'diagnostic/turn', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return new Response(
            JSON.stringify({ ok: true, data, request_id: requestId }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
        );
    }

    return new Response('Not Found', { status: 404 });
};

export const config = { path: '/api/symp/v1/diagnostic/*' };
