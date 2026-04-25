// POST /api/symp/v1/chat — streaming chat gateway with Vault context.
//
// Flow:
//   1. Validate x-symp-api-key.
//   2. Validate payload (user_id + messages[]).
//   3. Fetch Vault context for user_id (profile + symp_analysis + recent journals).
//   4. Prepend Vault-context system message to the client's messages.
//   5. Stream OpenAI response back as SSE.
//
// SSE wire format (matches existing /api/chat so Blaksyd parsers work unchanged):
//   data: {"delta":"token"}
//   data: {"done":true}
//   data: {"error":"..."}

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { buildVaultContextMessage } from '../../symp-core/lib/vault-context.mjs';
import { LANGUAGE_RULE_MESSAGE }    from '../../symp-core/lib/system-prompt.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

// Real-time data: gpt-4o-search-preview has built-in web browsing and ships
// answers grounded in live search results. We use it as the primary chat
// model. If it ever fails (rate limit, region issue, API hiccup), we fall
// back to plain gpt-4o.
//
// Note: gpt-4o-search-preview ignores temperature/top_p — those are fixed
// internally by the model. We still pass them on the fallback path so plain
// gpt-4o keeps its tuned warmth.
const MODEL_PRIMARY  = 'gpt-4o-search-preview';
const MODEL_FALLBACK = 'gpt-4o';

function buildPrimaryBody(messages, stream) {
    return {
        model:    MODEL_PRIMARY,
        messages,
        stream,
        max_tokens: stream ? 500 : 600,
        web_search_options: { search_context_size: 'low' },
    };
}
function buildFallbackBody(messages, stream) {
    return {
        model:       MODEL_FALLBACK,
        messages,
        stream,
        temperature: 0.75,
        max_tokens:  stream ? 500 : 600,
    };
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'BAD_REQUEST' });
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    }

    const { user_id, messages, stream = true } = parsed.data || {};

    if (!user_id) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'MISSING_USER_ID' });
        return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'BAD_REQUEST', userId: user_id });
        return jsonError(ERROR_CODES.BAD_REQUEST, 'messages[] is required and must be non-empty', 400, requestId);
    }

    const openaiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR', userId: user_id });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, 'OpenAI key not configured', 500, requestId);
    }

    // ── Vault context assembly ───────────────────────────────────────────────
    // Prepended to the client's messages so Blaksyd still owns persona/style
    // (its own system message stays in place) while Symp.ai owns who-the-
    // user-is. Failure to load context MUST NOT block chat — we log and
    // fall through with just the client's messages.
    // Order: LANGUAGE_RULE first (strongest, most recent in the system stack
    // before the user turn), then Vault context, then the client's messages.
    // The language rule is ALWAYS injected — even when Vault context fails or
    // is empty for new users — because language bleed is the #1 reported bug.
    let finalMessages = [LANGUAGE_RULE_MESSAGE, ...messages];
    try {
        const vaultMsg = await buildVaultContextMessage(user_id);
        if (vaultMsg) finalMessages = [LANGUAGE_RULE_MESSAGE, vaultMsg, ...messages];
    } catch (e) {
        console.warn(`[symp-v1-chat] Vault context fetch failed for ${user_id}:`, e.message);
    }

    // Helper: fetch OpenAI with primary (search-enabled) model, transparently
    // fall back to plain gpt-4o on a 4xx/5xx response so a model-side hiccup
    // never breaks the chat.
    const callOpenAI = async (stream) => {
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` };
        let res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers,
            body:   JSON.stringify(buildPrimaryBody(finalMessages, stream)),
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            console.warn(`[symp-v1-chat] primary model ${MODEL_PRIMARY} failed (${res.status}): ${errBody.slice(0,200)} — retrying with ${MODEL_FALLBACK}`);
            res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST', headers,
                body:   JSON.stringify(buildFallbackBody(finalMessages, stream)),
            });
        }
        return res;
    };

    // ── Non-streaming path (used by journal, vision pipelines, tests) ────────
    if (!stream) {
        try {
            const res = await callOpenAI(false);
            if (!res.ok) throw new Error(await res.text());
            const data  = await res.json();
            const reply = data.choices?.[0]?.message?.content || '';
            logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
            return new Response(
                JSON.stringify({ ok: true, data: { reply }, request_id: requestId }),
                { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
            );
        } catch (e) {
            logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
            return jsonError(ERROR_CODES.UPSTREAM_FAILED, String(e.message || e), 502, requestId);
        }
    }

    // ── Streaming SSE path ───────────────────────────────────────────────────
    let openaiRes;
    try {
        openaiRes = await callOpenAI(true);
    } catch (err) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
        return jsonError(ERROR_CODES.UPSTREAM_FAILED, String(err.message || err), 502, requestId);
    }

    if (!openaiRes.ok) {
        const errText = await openaiRes.text();
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
        return new Response(`data: ${JSON.stringify({ error: errText })}\n\n`, {
            status:  200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', [SYMP_REQUEST_ID_HEADER]: requestId },
        });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const { readable, writable } = new TransformStream();
    const writer  = writable.getWriter();

    // Async pump — runs concurrently with the Response being sent.
    (async () => {
        const reader = openaiRes.body.getReader();
        let buf = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const payload = t.slice(5).trim();
                    if (payload === '[DONE]') {
                        await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
                        continue;
                    }
                    try {
                        const token = JSON.parse(payload).choices?.[0]?.delta?.content;
                        if (token) {
                            await writer.write(encoder.encode(`data: ${JSON.stringify({ delta: token })}\n\n`));
                        }
                    } catch (_) { /* ignore malformed chunk */ }
                }
            }
        } catch (e) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
        } finally {
            await writer.close().catch(() => {});
            logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        }
    })();

    return new Response(readable, {
        status:  200,
        headers: {
            ...CORS_HEADERS,
            'Content-Type':     'text/event-stream',
            'Cache-Control':    'no-cache',
            'Connection':       'keep-alive',
            'X-Accel-Buffering': 'no',
            [SYMP_REQUEST_ID_HEADER]: requestId,
        },
    });
};

export const config = { path: '/api/symp/v1/chat' };
