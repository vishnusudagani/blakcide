// POST /api/symp/v1/action-loop/run
//
// CRON entry point. Scans active users, queues triggers, then fires due ones.
// Authenticated by x-symp-api-key (the same internal API key).
//
// Returns a small report so the CRON logs are useful: { queued, fired }.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, jsonSuccess, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { runOnce } from '../../symp-core/lib/action-loop.mjs';

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: '/api/symp/v1/action-loop/run', statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    try {
        const report = await runOnce({ limit: 500 });
        logAccess({ requestId, endpoint: '/api/symp/v1/action-loop/run', statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess(report, requestId);
    } catch (e) {
        logAccess({ requestId, endpoint: '/api/symp/v1/action-loop/run', statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
        return jsonError('INTERNAL_ERROR', String(e.message || e), 500, requestId);
    }
};

export const config = { path: '/api/symp/v1/action-loop/run' };
