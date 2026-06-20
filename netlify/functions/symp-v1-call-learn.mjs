// POST /api/symp/v1/call-learn — learn from one spoken-call exchange.
//
// Realtime Gemini Live calls run browser↔Vertex and never touch a Netlify
// function, so (unlike text chat and the turn-based voice fallback) they never
// fed the profile/knowledge engine — "calls don't store info". The browser now
// captures the live input/output transcription per turn and posts it here; we
// fan it into the SAME background-learning path as text chat (blak-learn-
// background → extractKnowledge + updateRollingMemory). No LLM reply is
// generated — Blak already spoke on the call; this is learning only.
//
// Auth: via the symp proxy (injects SYMP_API_KEY + the authoritative user_id
// from the verified Supabase JWT). The browser never holds the shared secret.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const requestId = getRequestId(req);
    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    const { user_id, userText, assistantText } = parsed.data || {};

    const ok = (data) => new Response(
        JSON.stringify({ ok: true, data, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );

    // Nothing the user actually said → nothing to learn (model-only turns, blips).
    if (!user_id || !String(userText || '').trim()) return ok({ noop: true });

    // Fan into the background learner (same shared-secret call as symp-v1-chat's
    // fireLearn). Best-effort: a learning hiccup must never surface on a call.
    try {
        const origin = new URL(req.url).origin;
        await fetch(`${origin}/.netlify/functions/blak-learn-background`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-blak-secret': process.env.SYMP_API_KEY || '' },
            body:    JSON.stringify({ user_id, userText, assistantText }),
        });
    } catch (e) { /* best-effort */ }

    return ok({ learned: true });
};

export const config = { path: '/api/symp/v1/call-learn' };
