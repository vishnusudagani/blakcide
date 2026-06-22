// POST /api/symp/v1/persona-share-meta — minimal public meta for a SHARED persona.
// A guest (not the owner) can't read fantasy_personas under RLS, so this returns
// JUST { id, name, avatar, tagline } when a valid, non-revoked share code is given.
// Gated by the unguessable share code (verified service-side). Never returns the
// backstory / knowledge / corrections — only what's needed to render the header.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { verifyPersonaShare, fetchFantasyPersonaById } from '../../symp-core/lib/supabase.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const { persona_id, share_code } = parsed.data || {};
    if (!persona_id || !share_code) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'persona_id and share_code are required', 400, requestId);
    }

    try {
        if (!(await verifyPersonaShare(persona_id, share_code))) {
            return jsonError('NOT_FOUND', 'Invalid or revoked share', 404, requestId);
        }
        const p = await fetchFantasyPersonaById(persona_id);
        if (!p) return jsonError('NOT_FOUND', 'Persona not found', 404, requestId);
        logAccess({ requestId, endpoint: 'persona-share-meta', statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess({ id: p.id, name: p.name || 'Persona', avatar: p.avatar || null, tagline: p.tagline || null }, requestId);
    } catch (e) {
        return jsonError('INTERNAL_ERROR', 'Could not load shared persona', 500, requestId);
    }
};

export const config = { path: '/api/symp/v1/persona-share-meta' };
