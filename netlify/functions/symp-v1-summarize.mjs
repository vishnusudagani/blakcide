// POST /api/symp/v1/summarize — recap a Blak thread in Blak's warm voice.
//
// The client sends the thread's messages (the proxy caps the count + injects
// the authoritative user_id). We return a short, friendly second-person recap
// the user reads in a slide-up sheet — "here's the gist of this chat."
//
// Not a clinical report, not a journal entry — a friend catching you up on what
// you two talked about. No mental-health framing.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

const SYS = [
    'You are Blak. Recap a chat you (Blak) had with your friend, FOR them to glance back at.',
    'Write a short, warm second-person recap ("you were figuring out…", "we talked about…") — like a friend reminding them what they got into.',
    'Lead with one plain sentence capturing the heart of the conversation. Then, if there were distinct threads, add up to 4 short bullet lines, each starting with "• ". If it was small, skip the bullets.',
    'Keep it tight (≤120 words total), concrete, and in the SAME language the user mainly used. Mention anything that was left open or decided.',
    'Never invent things that were not said. No headings, no "Summary:" prefix, no clinical or therapy language, no sign-off.',
].join('\n');

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const { user_id, messages, title } = parsed.data || {};
    if (!Array.isArray(messages) || messages.length < 2) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Not enough messages to summarize', 400, requestId);
    }

    // Build a readable transcript. Fold in media so the recap knows a photo or
    // voice note happened, using the description the app already stored.
    const transcript = messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => {
            let c = String(m.content || '').trim();
            if (m.media_type === 'audio') c = c || (m.media_description ? `[voice note: ${m.media_description}]` : '[voice note]');
            else if (m.media_type === 'call') c = `${c}`.trim();
            else if (m.media_url && m.media_description) c = (c ? c + ' ' : '') + `[shared an image: ${m.media_description}]`;
            else if (m.media_url) c = (c ? c + ' ' : '') + '[shared an image]';
            if (!c) return '';
            return `${m.role === 'user' ? 'You' : 'Blak'}: ${c.slice(0, 600)}`;
        })
        .filter(Boolean)
        .join('\n');

    if (!transcript) {
        return new Response(
            JSON.stringify({ ok: true, data: { summary: '' }, request_id: requestId }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
        );
    }

    let summary = '';
    try {
        const out = await chatCompleteFailover([
            { role: 'system', content: SYS },
            { role: 'user',   content: (title ? `Chat title: ${title}\n\n` : '') + `Conversation:\n${transcript}\n\nRecap this for me.` },
        ], { temperature: 0.5, maxTokens: 320, timeoutMs: 18000, tier: 'quality' });
        summary = (out.text || '').trim();
    } catch (e) {
        return jsonError(ERROR_CODES.UPSTREAM_ERROR || 'UPSTREAM_ERROR', 'Could not summarize right now', 502, requestId);
    }

    logAccess({ requestId, endpoint: 'summarize', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return new Response(
        JSON.stringify({ ok: true, data: { summary }, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );
};

export const config = { path: '/api/symp/v1/summarize' };
