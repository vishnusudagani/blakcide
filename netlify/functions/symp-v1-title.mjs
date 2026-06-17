// POST /api/symp/v1/title — name a conversation in 2–5 words.
//
// Runs on the FREE Groq floor (inference.mjs 'classifier' task = llama-3.1-8b-
// instant) so smart thread-naming costs nothing and never touches the Azure
// credit. Returns { title } in the user's own language.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { chatComplete } from '../../symp-core/lib/inference.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const { user_id, messages } = parsed.data || {};
    if (!Array.isArray(messages) || !messages.length) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'messages[] is required', 400, requestId);
    }

    const convo = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(0, 4)
        .map(m => `${m.role === 'user' ? 'User' : 'Blak'}: ${String(m.content || '').slice(0, 300)}`)
        .join('\n');

    let title = '';
    try {
        const out = await chatComplete({
            task: 'classifier', // → free Groq 8b-instant
            messages: [
                { role: 'system', content: 'Name what this chat is about in a SHORT title: 2–5 words, max ~32 characters, in the SAME language the user used. Output ONLY the title — no quotes, no trailing punctuation, no "Title:" prefix.' },
                { role: 'user',   content: convo },
            ],
            temperature: 0.3,
            max_tokens:  20,
            timeoutMs:   10000,
        });
        title = (out.content || '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/[.!,;:]+$/, '').slice(0, 40);
    } catch (e) {
        // best-effort — client keeps its first-message fallback title
    }

    logAccess({ requestId, endpoint: 'title', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return new Response(
        JSON.stringify({ ok: true, data: { title }, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );
};

export const config = { path: '/api/symp/v1/title' };
