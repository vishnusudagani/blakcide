// POST /api/symp/v1/vision — image → natural-language description.
// Wraps the existing /api/vision logic behind the Symp.ai API-key contract.
// Accepts { user_id?, imageUrl } (imageUrl can be http(s) or data:image/*).

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES } = SympContract;

const PROMPT = 'Describe this image in 1–3 natural sentences. Be specific: mention what objects, people, places, food, or atmosphere you see. Write as if a friend is casually describing a photo — no formal tone, no "I see..."';

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.VISION, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    }

    const { user_id, imageUrl } = parsed.data || {};
    if (!imageUrl) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'imageUrl is required', 400, requestId);
    }

    const openaiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        return jsonError(ERROR_CODES.INTERNAL_ERROR, 'OpenAI key not configured', 500, requestId);
    }

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
            body: JSON.stringify({
                model:      'gpt-4o-mini',
                max_tokens: 200,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: PROMPT },
                        { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
                    ],
                }],
            }),
        });

        const data = await res.json();
        if (!res.ok) {
            logAccess({ requestId, endpoint: ENDPOINTS.VISION, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id || null, errorCode: 'UPSTREAM_FAILED' });
            // Soft-fail: return a generic description so the calling flow doesn't break.
            return jsonSuccess({ description: 'An image was shared.' }, requestId);
        }

        const description = data.choices?.[0]?.message?.content?.trim() || 'An image was shared.';
        logAccess({ requestId, endpoint: ENDPOINTS.VISION, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id || null });
        return jsonSuccess({ description }, requestId);
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.VISION, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id || null, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `Vision error: ${e.message || e}`, 500, requestId);
    }
};

export const config = { path: '/api/symp/v1/vision' };
