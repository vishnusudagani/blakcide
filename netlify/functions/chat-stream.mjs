// ─── BLAKCIDE chat-stream  —  Netlify Functions v2 ──────────────────────────
// Real SSE streaming: GPT tokens flow to the client immediately.
// The client can start TTS on the first complete sentence while the rest
// of the response is still generating — cuts perceived latency by ~50%.
//
// Protocol (newline-delimited SSE):
//   data: {"delta":"token"}     ← incremental token
//   data: {"done":true}         ← stream finished
//   data: {"error":"..."}       ← fatal error

import { chatProviders, chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';
import { runStreamingChatWithTools } from '../../symp-core/lib/chat-runner.mjs';

// SympOS — emergency AI kill switch.
// Reads public.global_settings(key='ai_voice_killswitch') via PostgREST with
// the anon key (RLS allows public SELECT on global_settings). When enabled,
// every chat request is short-circuited with a calm 503 — no model call, no
// token spend. Cached for 30s so we don't hit Supabase on every request.
const KILLSWITCH_TTL_MS = 30_000;
let killswitchCache = { value: false, fetchedAt: 0 };

async function isAiKilled() {
    const now = Date.now();
    if (now - killswitchCache.fetchedAt < KILLSWITCH_TTL_MS) return killswitchCache.value;
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_ANON_KEY;
        if (!url || !key) return false;
        const r = await fetch(`${url}/rest/v1/global_settings?key=eq.ai_voice_killswitch&select=value`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        if (!r.ok) return false;
        const rows = await r.json();
        const enabled = !!(rows?.[0]?.value?.enabled);
        killswitchCache = { value: enabled, fetchedAt: now };
        return enabled;
    } catch (_) {
        return false;
    }
}

export default async (req) => {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    if (await isAiKilled()) {
        return new Response(JSON.stringify({
            error: 'AI is paused for maintenance',
            killswitch: true,
            message: 'We\u2019ve briefly paused the AI companion. Please try again shortly \u2014 your space is still here.',
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    let messages, stream_mode;
    try {
        const body = await req.json();
        messages    = body.messages;
        stream_mode = body.stream !== false; // default true
        if (!messages || !Array.isArray(messages)) throw new Error('No messages');
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const providers = chatProviders();
    if (providers.length === 0) {
        return new Response(JSON.stringify({ error: 'No open-source LLM providers configured' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }

    // ── Non-streaming fallback (used by journal, vision, etc.) ────────────────
    if (!stream_mode) {
        try {
            const { text } = await chatCompleteFailover(messages, { temperature: 0.75, maxTokens: 600 });
            return new Response(
                JSON.stringify({ reply: text || '' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 502 });
        }
    }

    // ── True SSE streaming via the open-source provider router ─────────────────
    // Reuses the tool-capable runner with an empty tool set, so this legacy
    // path gets the same provider failover and SSE format as /api/symp/v1/chat.
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
        try {
            await runStreamingChatWithTools({
                providers, tools: [], executeTool: async () => '', toolCtx: {},
                writer, encoder, messages, maxTokens: 500,
            });
        } catch (e) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message || String(e) })}\n\n`));
        } finally {
            await writer.close().catch(() => {});
        }
    })();

    return new Response(readable, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'  // disable nginx buffering if proxied
        }
    });
};

export const config = { path: '/api/chat' };
