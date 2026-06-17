// Streaming chat runner with tool-call support — OPEN-SOURCE provider edition.
//
// Responsibilities:
//   - Open a streaming chat completion against the first healthy OPEN-SOURCE
//     provider (Qwen 2.5 72B hosts → Groq/Llama floor; see llm-providers.mjs).
//     Every provider is OpenAI-Chat-Completions-compatible, so the wire format
//     (streaming deltas + tool-call deltas) is identical — no OpenAI anywhere.
//   - Pipe content tokens out as SSE `data: {"delta":"…"}\n\n` to the client
//   - On finish_reason='tool_calls', execute the tools, append the assistant
//     turn (with tool_calls) and the tool results to the message stack,
//     then recurse with stream=true
//   - Emit side-channel SSE meta events when specific tools fire so the
//     frontend can render UI cards (escalate_to_human, suggest_switch_to_text,
//     swap_persona) without parsing the model's text
//
// Failover: for each round we try providers in priority order until one returns
// OK headers; the provider that worked is reused for subsequent tool rounds so
// the model/voice stays consistent across a single answer. Only if every
// provider fails do we surface an error event.
//
// NEVER-EMPTY GUARANTEE: open models (e.g. Llama 3.3 70B) sometimes keep
// emitting tool calls — or return an empty message when tools are offered —
// instead of settling on a text answer, which previously left the user with a
// blank "…" reply. We defend against that two ways:
//   1. The FINAL round is always run with tools DISABLED, so the model must
//      produce a text answer from whatever tool results it has gathered.
//   2. If a non-final round comes back empty (no text, no tool call), we fall
//      through to that forced text round instead of returning blank.
// Tool rounds are still capped at MAX_TOOL_ROUNDS so a buggy tool can't loop.
//
// SSE wire format extensions (existing parsers ignore unknown keys):
//   data: {"delta":"token"}            — content token
//   data: {"meta":{"type":"…","payload":{…}}}  — UI hint
//   data: {"done":true}                — finished
//   data: {"error":"…"}                — fatal error

import { chatProviders, authHeadersFor } from './llm-providers.mjs';

// Two rounds max: one tool-enabled round, then a forced plain-text round. This
// caps a single user message at TWO upstream calls (not three), which matters a
// lot on a free-tier floor provider where every extra call burns the
// tokens-per-minute budget and triggers 429s.
const MAX_TOOL_ROUNDS = 2;

// Statuses worth waiting-and-retrying on the SAME provider before falling
// through to the next one. 429 = rate limit (free tiers hit this constantly),
// 5xx = transient upstream blips. The non-OK response arrives before any
// streaming starts, so retrying the request is safe.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tools whose execution should also surface a UI hint to the frontend.
const META_TOOLS = new Set([
    'escalate_to_human',
    'suggest_switch_to_text',
    'swap_persona',
]);

// Tools whose execution should also surface a UI hint to the frontend.
const META_TOOLS = new Set([
    'escalate_to_human',
    'suggest_switch_to_text',
    'swap_persona',
]);

/**
 * Run a streaming chat with tool support. Writes SSE chunks to `writer`.
 *
 * @param {Object}   opts
 * @param {Array}    [opts.providers]     — open-source provider list (defaults to chatProviders())
 * @param {Array}    opts.messages        — initial message stack (system + user/assistant)
 * @param {Array}    opts.tools           — OpenAI-format tool definitions (may be [])
 * @param {Function} opts.executeTool     — async (name, args, ctx) → string
 * @param {Object}   opts.toolCtx         — { userId, … } passed through to executors
 * @param {Object}   opts.writer          — TransformStream writer
 * @param {TextEncoder} opts.encoder
 * @param {number}   [opts.maxTokens]
 */
export async function runStreamingChatWithTools(opts) {
    const {
        tools, executeTool, toolCtx,
        writer, encoder, maxTokens = 600,
    } = opts;
    const messages = opts.messages.slice();

    const candidates = (opts.providers && opts.providers.length) ? opts.providers : chatProviders();
    if (!candidates.length) {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: 'No open-source LLM providers configured' })}\n\n`));
        return;
    }
    // Stick with whichever provider answered last round for consistency.
    let preferred = candidates[0];

    const hasTools = Array.isArray(tools) && tools.length > 0;

    // Stream a single completion round against the current `messages`. Forwards
    // content deltas to the client as they arrive. Returns the round outcome.
    // `useTools` controls whether tool definitions are offered this round.
    async function streamRound(useTools) {
        const order = [preferred, ...candidates.filter(p => p !== preferred)];
        let res = null;
        let lastErr = '';
        for (const p of order) {
            const body = {
                model:       p.model,
                messages,
                stream:      true,
                temperature: 0.75,
                max_tokens:  maxTokens,
            };
            if (useTools && p.supportsTools !== false) {
                body.tools       = tools;
                body.tool_choice = 'auto';
            }
            // Up to 3 attempts per provider, backing off on 429/5xx (honouring
            // Retry-After when the host sends it). Only once these are exhausted
            // do we fall through to the next provider — so a lone free-tier
            // floor (Groq only) can still recover from a transient rate limit
            // instead of dead-ending the whole turn.
            for (let attempt = 0; attempt < 3 && !res; attempt++) {
                try {
                    const r = await fetch(p.baseUrl, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeadersFor(p), ...(p.headers || {}) },
                        body:    JSON.stringify(body),
                    });
                    if (!r.ok) {
                        lastErr = `${p.id}:${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`;
                        if (RETRYABLE_STATUS.has(r.status) && attempt < 2) {
                            const ra = parseFloat(r.headers.get('retry-after') || '');
                            const waitMs = Math.min(Number.isFinite(ra) ? ra * 1000 : 500 * 2 ** attempt, 4000);
                            await sleep(waitMs);
                            continue;            // retry the SAME provider
                        }
                        break;                   // non-retryable / out of attempts → next provider
                    }
                    res = r;
                    preferred = p;
                } catch (e) {
                    lastErr = `${p.id}:${(e?.message || e).toString().slice(0, 100)}`;
                    if (attempt < 2) { await sleep(400); continue; }  // transient network blip
                    break;
                }
            }
            if (res) break;
        }
        if (!res) return { ok: false, err: lastErr };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let content = '';
        const toolCalls = []; // [{id, name, argsBuf}], indexed
        let finishReason = null;

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
                    if (!payload || payload === '[DONE]') continue;
                    let chunk;
                    try { chunk = JSON.parse(payload); } catch (_) { continue; }
                    const choice = chunk.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta || {};

                    // Content tokens — forward immediately
                    if (typeof delta.content === 'string' && delta.content.length) {
                        content += delta.content;
                        await writer.write(encoder.encode(`data: ${JSON.stringify({ delta: delta.content })}\n\n`));
                    }

                    // Tool-call deltas — accumulate by index
                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', argsBuf: '' };
                            if (tc.id)                  toolCalls[idx].id      = tc.id;
                            if (tc.function?.name)      toolCalls[idx].name    = tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].argsBuf += tc.function.arguments;
                        }
                    }

                    if (choice.finish_reason) finishReason = choice.finish_reason;
                }
            }
        } catch (e) {
            return { ok: false, err: e.message || String(e) };
        }

        return { ok: true, content, toolCalls: toolCalls.filter(Boolean), finishReason };
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Force a plain-text answer on the final round: with tools off, the model
        // must respond in text instead of looping on another tool call.
        const useTools = hasTools && round < MAX_TOOL_ROUNDS - 1;

        const r = await streamRound(useTools);
        if (!r.ok) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: `All providers failed → ${r.err}` })}\n\n`));
            return;
        }

        const wantsTools = useTools && r.finishReason === 'tool_calls' && r.toolCalls.length > 0;

        if (!wantsTools) {
            // Model is done for this round. If it produced text, finish. If it
            // came back empty (an open-model quirk when tools are offered) and we
            // still have rounds left, loop again — the final round forces text.
            if (r.content.trim() || round === MAX_TOOL_ROUNDS - 1) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
                return;
            }
            continue;
        }

        // ── Tool round ─────────────────────────────────────────────────────
        // Append the assistant turn (with tool_calls) so the model recognises
        // the tool replies on the next round.
        messages.push({
            role:       'assistant',
            content:    r.content || null,
            tool_calls: r.toolCalls.map(tc => ({
                id:       tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                type:     'function',
                function: { name: tc.name, arguments: tc.argsBuf || '{}' },
            })),
        });

        for (const tc of r.toolCalls) {
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(tc.argsBuf || '{}'); } catch (_) { parsedArgs = {}; }

            // Never let a throwing tool kill the stream — feed the error back so
            // the model can recover and still answer.
            let result;
            try { result = await executeTool(tc.name, parsedArgs, toolCtx); }
            catch (e) { result = `tool_error: ${e?.message || e}`; }

            // Side-channel meta event so the frontend can render a UI card.
            if (META_TOOLS.has(tc.name)) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                    meta: { type: tc.name, payload: parsedArgs }
                })}\n\n`));
            }

            messages.push({
                role:         'tool',
                tool_call_id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                content:      String(result ?? ''),
            });
        }
        // Loop continues — model gets to use the tool output to compose the final answer.
    }

    // Safety net — the final round runs with tools disabled, so we normally
    // return from inside the loop. This only fires in degenerate cases; never
    // leave the connection hanging.
    await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
}
