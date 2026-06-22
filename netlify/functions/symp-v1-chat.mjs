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
import { fetchFantasyPersona, fetchFantasyPersonaById, verifyPersonaShare } from '../../symp-core/lib/supabase.mjs';
import { TOOL_DEFS, executeTool } from '../../symp-core/lib/tools.mjs';
import { runStreamingChatWithTools } from '../../symp-core/lib/chat-runner.mjs';
import { chatProviders } from '../../symp-core/lib/llm-providers.mjs';
import { recordEventAsync } from '../../symp-core/lib/vibe-tracker.mjs';
// Post-turn learning (fact extraction + rolling memory) now runs in the
// blak-learn-background function — off the request path, so it can't be cut off
// by the response deadline. See fireLearn() below.
import { analyseTurn } from '../../symp-core/lib/diagnostic.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

// Fire-and-forget trigger to the background learning function. The 202 returns
// fast (so awaiting it is safe within the request), then extraction + memory run
// independently with no deadline. Best-effort — never blocks or breaks the chat.
async function fireLearn(req, userId, userText, assistantText, opts = {}) {
    if (!userId || !userText) return;
    try {
        const origin = new URL(req.url).origin;
        await fetch(`${origin}/.netlify/functions/blak-learn-background`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-blak-secret': process.env.SYMP_API_KEY || '' },
            body:    JSON.stringify({
                user_id: userId, userText, assistantText,
                // Fantasy persona chat: update the persona's OWN memory of this user.
                // skip_global=true when the persona's build_profile_from is off (memory
                // still updates; the global profile/knowledge does not).
                persona_id:   opts.persona_id   || null,
                persona_name: opts.persona_name || null,
                skip_global:  !!opts.skip_global,
            }),
        });
    } catch (e) { /* learning is best-effort */ }
}

// Open-source brain: Qwen 2.5 72B (Together / Fireworks / DeepInfra / OpenRouter)
// with Groq + Llama 3.3 70B as the always-free downtime floor. The active model
// is chosen per-request by the provider router (llm-providers.mjs) based on which
// keys are configured. Live web data is exposed via the search_web tool.

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

    const { user_id, messages, stream = true, source_session_id = null, persona_id = null, mode = 'normal', no_learn = false, share_code = null } = parsed.data || {};

    if (!user_id) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'MISSING_USER_ID' });
        return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'BAD_REQUEST', userId: user_id });
        return jsonError(ERROR_CODES.BAD_REQUEST, 'messages[] is required and must be non-empty', 400, requestId);
    }

    const providers = chatProviders();
    if (providers.length === 0) {
        logAccess({ requestId, endpoint: ENDPOINTS.CHAT, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR', userId: user_id });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, 'No open-source LLM providers configured', 500, requestId);
    }

    // ── Token diet for the free floor ────────────────────────────────────
    // Groq's free tier is 12k tokens/MINUTE. Tool definitions (~400 tokens)
    // PLUS the empty-round-with-tools double-call (open models often emit an
    // empty first round when tools are dangled, forcing a second call) burn
    // that budget ~2.5x per message — the gap between ~2 and ~6 messages/min,
    // i.e. the "I lost my train of thought" breakage. When the ONLY configured
    // provider is the Groq floor we drop tools so every turn is ONE lean call.
    // Add any higher-capacity provider (Gemini credits / a Qwen key) and full
    // tools switch back on automatically — no code change.
    const floorOnly   = providers.length === 1 && providers[0].id === 'groq';
    const activeTools = floorOnly ? [] : TOOL_DEFS;

    // ── Build the layered system stack ───────────────────────────────────
    const latestUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    // Fantasy persona chat? Load it (service role, scoped to this user) so the
    // prompt becomes the persona — and learning respects its consent toggle.
    let persona = null;
    let isShared = false;
    if (persona_id) {
        try { persona = await fetchFantasyPersona(user_id, persona_id); } catch (_) { /* fall back to Blak */ }
        // Not the owner? A valid, non-revoked share grants GUEST access: persona-only
        // (never inject the owner's profile) and NO learning (a guest chat writes to
        // nobody's profile/memory). The share code is verified service-side.
        if (!persona && persona_id && share_code) {
            try {
                const share = await verifyPersonaShare(persona_id, share_code);
                if (share) {
                    const p = await fetchFantasyPersonaById(persona_id);
                    // _reveal: 'persona_only' (just the character) or 'knows_me' (may also
                    // draw on what it remembers about its creator — never the raw profile).
                    if (p) { persona = { ...p, can_use_profile: false, _shared: true, _reveal: share.reveal || 'persona_only' }; isShared = true; }
                }
            } catch (_) { /* no access → falls back to Blak */ }
        }
    }
    // Incognito (no_learn) AND guest/shared chats skip ALL learning + memory.
    const mayLearn = (!persona || persona.build_profile_from !== false) && no_learn !== true && !isShared;
    let systemStack = [];
    try {
        systemStack = await buildChatSystemStack(user_id, { latestUserText, persona, mode });
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
                providers, tools: activeTools, executeTool,
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
        // In clone mode the assistant speaks AS the user (first person); learning from
        // its own words would echo the clone's guesses back into the profile. So learn
        // only from what the USER actually said.
        const learnAssistant = mode === 'clone' ? '' : assembled;
        // Fantasy persona: its OWN memory of you always updates (that's how the
        // character remembers your history); the global profile/vibe stay gated by
        // the build_profile_from consent toggle. Blak/clone path is unchanged.
        if (persona && !isShared) {
            await fireLearn(req, user_id, lastUser, learnAssistant, { persona_id, persona_name: persona.name, skip_global: !mayLearn });
            if (mayLearn) {
                recordEventAsync(user_id, { source: 'ai_chat', sourceSessionId: source_session_id, evidence: learnAssistant ? `User: ${lastUser}\n\nAssistant: ${learnAssistant}` : `User: ${lastUser}` });
            }
        } else if (mayLearn) {
            recordEventAsync(user_id, {
                source: 'ai_chat',
                sourceSessionId: source_session_id,
                evidence: learnAssistant ? `User: ${lastUser}\n\nAssistant: ${learnAssistant}` : `User: ${lastUser}`,
            });
            // Hand learning off to the background function (reliable, off the request path).
            await fireLearn(req, user_id, lastUser, learnAssistant);
        }

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
                providers, tools: activeTools, executeTool,
                toolCtx: { userId: user_id }, writer: teeWriter, encoder,
                messages: finalMessages, maxTokens: 600,
            });
        } catch (e) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message || String(e) })}\n\n`));
        } finally {
            // Run learning BEFORE closing the stream. The runner already emitted
            // {"done":true}, so the client is unblocked; holding the stream open
            // keeps the serverless function alive until this finishes. Work queued
            // AFTER close gets dropped when the runtime freezes on response complete.
            const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
            // Clone mode: learn only from the user's words (see non-stream path).
            const learnAssistant = mode === 'clone' ? '' : assembledForVibe;
            // Persona's own memory always updates; global profile/vibe gated by consent
            // (see non-stream path above). Blak/clone path unchanged.
            if (persona && !isShared) {
                await fireLearn(req, user_id, lastUser, learnAssistant, { persona_id, persona_name: persona.name, skip_global: !mayLearn });
                if (mayLearn) {
                    recordEventAsync(user_id, { source: 'ai_chat', sourceSessionId: source_session_id, evidence: learnAssistant ? `User: ${lastUser}\n\nAssistant: ${learnAssistant}` : `User: ${lastUser}` });
                }
            } else if (mayLearn) {
                recordEventAsync(user_id, {
                    source: 'ai_chat',
                    sourceSessionId: source_session_id,
                    evidence: learnAssistant ? `User: ${lastUser}\n\nAssistant: ${learnAssistant}` : `User: ${lastUser}`,
                });
                await fireLearn(req, user_id, lastUser, learnAssistant);
            }

            // Self-correction analysis — pins next-turn corrective hint.
            try {
                analyseTurn({
                    userId:    user_id,
                    userText:  lastUser,
                    modelText: assembledForVibe,
                    surface:   'chat',
                });
            } catch (_) { /* never block on diagnostic */ }

            await writer.close().catch(() => {});
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
