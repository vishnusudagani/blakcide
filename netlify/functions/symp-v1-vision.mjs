// POST /api/symp/v1/vision — image → natural-language description.
// Wraps the existing /api/vision logic behind the Symp.ai API-key contract.
// Accepts { user_id?, imageUrl } (imageUrl can be http(s) or data:image/*).

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { chatComplete, InferenceError } from '../../symp-core/lib/inference.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES } = SympContract;

const PROMPT = 'Describe this image in 1–3 natural sentences. Be specific: mention what objects, people, places, food, or atmosphere you see. Write as if a friend is casually describing a photo — no formal tone, no "I see..."';

// Read fine detail (text in a sign/menu/screenshot) when answering a question.
function question_detail(prompt) { return prompt && prompt !== PROMPT ? 'high' : 'low'; }

// Vision needs a MULTIMODAL model. The shared inference router is pinned to a
// text-only background model (Groq Llama), so describe via Azure gpt-4.1-mini —
// the same multimodal model that powers the user chat. Never throws; null on miss.
async function describeImageAzure(imageUrl, prompt = PROMPT) {
    const ep = process.env.AZURE_OPENAI_ENDPOINT, dep = process.env.AZURE_OPENAI_DEPLOYMENT, key = process.env.AZURE_OPENAI_API_KEY;
    if (!ep || !dep || !key) return null;
    const ver = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    const url = ep.replace(/\/+$/, '') + '/openai/deployments/' + dep + '/chat/completions?api-version=' + ver;
    try {
        const r = await fetch(url, {
            method:  'POST',
            headers: { 'api-key': key, 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                messages: [{ role: 'user', content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageUrl, detail: question_detail(prompt) } },
                ] }],
                max_tokens: 240, temperature: 0.6,
            }),
        });
        if (!r.ok) return null;
        const d = await r.json();
        return d?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) { return null; }
}

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

    const { user_id, imageUrl, question } = parsed.data || {};
    if (!imageUrl) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'imageUrl is required', 400, requestId);
    }
    // A question → re-examine the image to answer it; otherwise a casual describe.
    const prompt = (typeof question === 'string' && question.trim())
        ? `Answer this question about the image in 1–3 short, natural, specific sentences (casual, like a friend): "${question.trim().slice(0, 300)}". If the answer isn't visible in the image, say so plainly.`
        : PROMPT;

    try {
        // Multimodal describe via Azure first; fall back to the router, then a generic line.
        let description = await describeImageAzure(imageUrl, prompt);
        if (!description) {
            try {
                const out = await chatComplete({
                    task: 'vision', max_tokens: 240, temperature: 0.6,
                    messages: [{ role: 'user', content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: imageUrl, detail: question_detail(prompt) } },
                    ] }],
                });
                description = out.content?.trim() || null;
            } catch (_) { /* text-only router can't see images — generic fallback below */ }
        }
        if (!description) description = 'An image was shared.';
        logAccess({ requestId, endpoint: ENDPOINTS.VISION, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id || null });
        return jsonSuccess({ description }, requestId);
    } catch (e) {
        const isUpstream = e instanceof InferenceError;
        logAccess({
            requestId, endpoint: ENDPOINTS.VISION,
            statusCode: 200, latencyMs: Date.now() - t0,
            userId: user_id || null,
            errorCode: isUpstream ? 'UPSTREAM_FAILED' : 'INTERNAL_ERROR',
        });
        // Soft-fail: return a generic description so the calling flow doesn't break.
        return jsonSuccess({ description: 'An image was shared.' }, requestId);
    }
};

export const config = { path: '/api/symp/v1/vision' };
