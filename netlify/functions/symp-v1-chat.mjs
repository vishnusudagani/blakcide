// POST /api/symp/v1/chat — streaming chat gateway with the Unified Soul stack.
//
// Layers prepended ahead of the client's messages:
//   1. CORE IDENTITY                  — relatable digital companion + honesty
//   2. CRITICAL OVERRIDE              — language mirroring + native fluency
//   3. REAL-TIME DATA                 — when to use search vs voice cutoff
//   4. ACTIVE PERSONA CARD            — friend / father / mother / astrologer / etc.
//   5. CURRENT VIBE SNAPSHOT          — tiny "where the user is" line
//   6. VAULT CONTEXT                  — profile + analysis + recent journals
//
// Tools are enabled (see TOOL_DEFS): search_vault, get_live_context, search_web,
// swap_persona, escalate_to_human, suggest_switch_to_text, fetch_soft_insight.
//
// After the response is delivered, we fire a vibe event (last user turn +
// the model's text) into vibe-tracker.recordEventAsync — non-blocking, so the
// next interaction's prompt has fresher context.
//
// SSE wire format (chat-runner.mjs writes):
//   data: {"delta":"token"}
//   data: {"meta":{"type":"escalate_to_human","payload":{…}}}
//   data: {"done":true}
//   data: {"error":"..."}

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { buildChatSystemStack } from '../../symp-core/lib/system-prompt.mjs';
import { TOOL_DEFS, executeTool } from '../../symp-core/lib/tools.mjs';
import { runStreamingChatWithTools } from '../../symp-core/lib/chat-runner.mjs';
import { recordEventAsync } from '../../symp-core/lib/vibe-tracker.mjs';
import { analyseTurn } from '../../symp-core/lib/diagnostic.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

// Plain gpt-4o for chat (search-preview doesn't support function-calling).
// Live web data is now exposed via the search_web tool, which sub-calls
// search-preview internally.
const MODEL = 'gpt-4o';

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0        = Date.now();
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

    const { user_id, messages, stream = true, source_session_id = null } = parsed.data || {};

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

    // ── Build the layered system stack ───────────────────────────────────
    let systemStack = [];
    try {
        systemStack = await buildChatSystemStack(user_id);
    } catch (e) {
        console.warn(`[symp-v1-chat] system-stack build failed for ${user_id}: ${e.message}`);
        // Soft fall-through: the chat still goes out, just less personalised.
    }

    const finalMessages = [...systemStack, ...messages];

    // For non-streaming mode (used by some pipelines), we still go through
    // the streaming runner but write into a buffer and assemble at the end.
    if (!stream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        let assembled = '';
        let metaEvents = [];

        // Tee the writer: capture everything the runner emits, decode, accumulate.
        const captureWriter = {
            write: async (chunk) => {
                const text = new TextDecoder().decode(chunk);
                for (const line of text.split('\n')) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    try {
                        const obj = JSON.parse(t.slice(5).trim());
                        if (obj.delta) assembled += obj.delta;
                        if (obj.meta)  metaEvents.push(obj.meta);
                    } catch (_) { /* ignore */ }
                }
                await writer.write(chunk);
            },
            close: () => writer.close(),
        };

        try {
            await runStreamingChatWithTools({
                openaiKey, model: MODEL, tools: TOOL_DEFS, executeTool,
                toolCtx: { userId: user_id }, writer: captureWriter, encoder,
                messages: finalMessages, maxTokens: 600,
            });
            await captureWriter.close();
        } catch (e) {
            logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
            return jsonError(ERROR_CODES.UPSTREAM_FAILED, String(e.message || e), 502, requestId);
        }

        // Vibe write — fire and forget.
        const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
        recordEventAsync(user_id, {
            source: 'ai_chat',
            sourceSessionId: source_session_id,
            evidence: `User: ${lastUser}\n\nAssistant: ${assembled}`,
        });

        // Self-correction analysis — synchronous but cheap (regex-only).
        try {
            analyseTurn({
                userId:    user_id,
                userText:  lastUser,
                modelText: assembled,
                surface:   'chat',
            });
        } catch (_) { /* never block on diagnostic */ }

        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return new Response(
            JSON.stringify({ ok: true, data: { reply: assembled, meta: metaEvents }, request_id: requestId }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
        );
    }

    // ── Streaming SSE path ───────────────────────────────────────────────
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Capture the assistant's text as it streams so we can fire the vibe
    // event after the stream closes. We wrap the writer with a tee.
    let assembledForVibe = '';
    const teeWriter = {
        write: async (chunk) => {
            const text = new TextDecoder().decode(chunk);
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                try {
                    const obj = JSON.parse(t.slice(5).trim());
                    if (obj.delta) assembledForVibe += obj.delta;
                } catch (_) { /* ignore */ }
            }
            await writer.write(chunk);
        },
    };

    (async () => {
        try {
            await runStreamingChatWithTools({
                openaiKey, model: MODEL, tools: TOOL_DEFS, executeTool,
                toolCtx: { userId: user_id }, writer: teeWriter, encoder,
                messages: finalMessages, maxTokens: 600,
            });
        } catch (e) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message || String(e) })}\n\n`));
        } finally {
            await writer.close().catch(() => {});

            // Vibe write — fire and forget.
            const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
            recordEventAsync(user_id, {
                source: 'ai_chat',
                sourceSessionId: source_session_id,
                evidence: `User: ${lastUser}\n\nAssistant: ${assembledForVibe}`,
            });

            // Self-correction analysis — pins next-turn corrective hint.
            try {
                analyseTurn({
                    userId:    user_id,
                    userText:  lastUser,
                    modelText: assembledForVibe,
                    surface:   'chat',
                });
            } catch (_) { /* never block on diagnostic */ }

            logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        }
    })();

    return new Response(readable, {
        status: 200,
        headers: {
            ...CORS_HEADERS,
            'Content-Type':           'text/event-stream',
            'Cache-Control':          'no-cache',
            'Connection':             'keep-alive',
            'X-Accel-Buffering':      'no',
            [SYMP_REQUEST_ID_HEADER]: requestId,
        },
    });
};

export const config = { path: '/api/symp/v1/chat' };
