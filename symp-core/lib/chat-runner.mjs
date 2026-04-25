// Streaming chat runner with tool-call support.
//
// Responsibilities:
//   - Open a streaming OpenAI completion
//   - Pipe content tokens out as SSE `data: {"delta":"…"}\n\n` to the client
//   - On finish_reason='tool_calls', execute the tools, append the assistant
//     turn (with tool_calls) and the tool results to the message stack,
//     then recurse with stream=true
//   - Emit side-channel SSE meta events when specific tools fire so the
//     frontend can render UI cards (escalate_to_human, suggest_switch_to_text,
//     swap_persona) without parsing the model's text
//
// Cap recursion at MAX_TOOL_ROUNDS (3) so a buggy tool can't infinite-loop.
//
// SSE wire format extensions (existing parsers ignore unknown keys):
//   data: {"delta":"token"}            — content token
//   data: {"meta":{"type":"…","payload":{…}}}  — UI hint
//   data: {"done":true}                — finished
//   data: {"error":"…"}                — fatal error

const MAX_TOOL_ROUNDS = 3;

/**
 * Run a streaming chat with tool support. Writes SSE chunks to `writer`.
 *
 * @param {Object}   opts
 * @param {string}   opts.openaiKey
 * @param {string}   opts.model
 * @param {Array}    opts.messages       — initial message stack (system + user/assistant)
 * @param {Array}    opts.tools          — OpenAI tool definitions
 * @param {Function} opts.executeTool    — async (name, args, ctx) → string
 * @param {Object}   opts.toolCtx        — { userId, … } passed through to executors
 * @param {Object}   opts.writer         — TransformStream writer
 * @param {TextEncoder} opts.encoder
 * @param {number}   [opts.maxTokens]
 */
export async function runStreamingChatWithTools(opts) {
    const {
        openaiKey, model, tools, executeTool, toolCtx,
        writer, encoder, maxTokens = 600,
    } = opts;
    let messages = opts.messages.slice();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
            body:   JSON.stringify({
                model,
                messages,
                stream:      true,
                temperature: 0.75,
                max_tokens:  maxTokens,
                tools,
                tool_choice: 'auto',
            }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: errText.slice(0, 400) })}\n\n`));
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        // Per-stream accumulators
        let collectedContent = '';
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
                        collectedContent += delta.content;
                        await writer.write(encoder.encode(`data: ${JSON.stringify({ delta: delta.content })}\n\n`));
                    }

                    // Tool-call deltas — accumulate by index
                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', argsBuf: '' };
                            if (tc.id)                     toolCalls[idx].id      = tc.id;
                            if (tc.function?.name)         toolCalls[idx].name    = tc.function.name;
                            if (tc.function?.arguments)    toolCalls[idx].argsBuf += tc.function.arguments;
                        }
                    }

                    if (choice.finish_reason) finishReason = choice.finish_reason;
                }
            }
        } catch (e) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message || String(e) })}\n\n`));
            return;
        }

        // Stop conditions
        if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
            // Normal completion or stop
            await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
            return;
        }

        // ── Tool round ─────────────────────────────────────────────────────
        // Append the assistant turn (with tool_calls) so OpenAI recognises
        // the tool replies on the next round.
        messages.push({
            role:       'assistant',
            content:    collectedContent || null,
            tool_calls: toolCalls.filter(Boolean).map(tc => ({
                id:       tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                type:     'function',
                function: { name: tc.name, arguments: tc.argsBuf || '{}' },
            })),
        });

        for (const tc of toolCalls) {
            if (!tc) continue;
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(tc.argsBuf || '{}'); } catch (_) { parsedArgs = {}; }
            const result = await executeTool(tc.name, parsedArgs, toolCtx);

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

    // Hit the round cap — stop cleanly so the user gets *something*.
    await writer.write(encoder.encode(`data: ${JSON.stringify({ delta: '' })}\n\n`));
    await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
}

// Tools whose execution should also surface a UI hint to the frontend.
const META_TOOLS = new Set([
    'escalate_to_human',
    'suggest_switch_to_text',
    'swap_persona',
]);
