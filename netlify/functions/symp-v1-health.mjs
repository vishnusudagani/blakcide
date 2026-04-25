// GET /api/symp/v1/health — liveness + version check. Minimal endpoint that
// proves the API-key contract and Netlify routing are both wired correctly.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, SYMP_API_VERSION } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'GET' && req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.HEALTH, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const res = jsonSuccess({
        version: SYMP_API_VERSION,
        time:    new Date().toISOString(),
        service: 'symp.ai',
    }, requestId);
    logAccess({ requestId, endpoint: ENDPOINTS.HEALTH, statusCode: 200, latencyMs: Date.now() - t0 });
    return res;
};

export const config = { path: '/api/symp/v1/health' };
