// Persona endpoints:
//   GET  /api/symp/v1/persona/state?user_id=…    → current active persona row
//   POST /api/symp/v1/persona/swap               → { user_id, persona, reason } → swap
//   GET  /api/symp/v1/personas                   → static list of available personas

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, jsonSuccess, readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { listPersonas, isValidPersona } from '../../symp-core/lib/persona-engine.mjs';
import { fetchPersonaState, upsertPersonaState } from '../../symp-core/lib/supabase.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    const t0 = Date.now();
    const requestId = getRequestId(req);
    const url = new URL(req.url);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: url.pathname, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    // GET /personas — public list
    if (req.method === 'GET' && url.pathname.endsWith('/personas')) {
        return jsonSuccess({ personas: listPersonas() }, requestId);
    }

    // GET /persona/state — current row
    if (req.method === 'GET' && url.pathname.endsWith('/persona/state')) {
        const userId = url.searchParams.get('user_id');
        if (!userId) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        const row = await fetchPersonaState(userId).catch(() => null);
        return jsonSuccess(row || { active_persona: 'friend', locked: false, swap_history: [] }, requestId);
    }

    // POST /persona/swap
    if (req.method === 'POST' && url.pathname.endsWith('/persona/swap')) {
        const parsed = await readJson(req);
        if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
        const { user_id, persona, reason = '' } = parsed.data || {};
        if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
        if (!isValidPersona(persona)) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid persona id', 400, requestId);

        const current = await fetchPersonaState(user_id).catch(() => null);
        if (current?.locked && current.active_persona !== persona) {
            return jsonError(ERROR_CODES.BAD_REQUEST, 'Persona is locked for this user', 409, requestId);
        }
        const history = Array.isArray(current?.swap_history) ? current.swap_history.slice(-19) : [];
        history.push({ persona, at: new Date().toISOString(), reason: String(reason).slice(0, 200) });

        const upd = await upsertPersonaState({ userId: user_id, activePersona: persona, swapHistory: history });
        logAccess({ requestId, endpoint: url.pathname, userId: user_id, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ active_persona: persona, action: upd.action }, requestId);
    }

    return new Response('Method Not Allowed', { status: 405 });
};

export const config = {
    path: ['/api/symp/v1/personas', '/api/symp/v1/persona/state', '/api/symp/v1/persona/swap'],
};
