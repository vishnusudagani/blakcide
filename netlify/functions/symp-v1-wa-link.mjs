// POST /api/symp/v1/wa-link — create a one-time web→WhatsApp link code for a user.
// Returns { code, wa_link }. The web app renders wa_link as a "Connect WhatsApp"
// button: it opens WhatsApp pre-filled with the code; the user hits send and the
// webhook binds that phone to their account (one brain across web + WhatsApp).
import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError, readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { createLinkCode } from '../../symp-core/lib/whatsapp.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const { user_id } = parsed.data || {};
    if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);

    const res = await createLinkCode(user_id);
    if (!res.ok) return jsonError(ERROR_CODES.INTERNAL_ERROR, 'Could not create link code', 500, requestId);

    // Public WhatsApp number (digits only, e.g. 15556457350 test / 917702063434 real).
    const num = (process.env.WHATSAPP_WA_ME_NUMBER || '').replace(/\D/g, '');
    const wa_link = num ? `https://wa.me/${num}?text=${encodeURIComponent(res.code)}` : null;

    logAccess({ requestId, endpoint: ENDPOINTS.WA_LINK || '/api/symp/v1/wa-link', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return jsonSuccess({ code: res.code, wa_link }, requestId);
};

export const config = { path: '/api/symp/v1/wa-link' };
