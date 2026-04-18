// ─── BLAKCIDE chat-stream  —  Netlify Functions v2 ──────────────────────────
// Real SSE streaming: GPT tokens flow to the client immediately.
// The client can start TTS on the first complete sentence while the rest
// of the response is still generating — cuts perceived latency by ~50%.
//
// Protocol (newline-delimited SSE):
//   data: {"delta":"token"}     ← incremental token
//   data: {"done":true}         ← stream finished
//   data: {"error":"..."}       ← fatal error

export default async (req) => {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
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

    const apiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }

    // ── Non-streaming fallback (used by journal, vision, etc.) ────────────────
    if (!stream_mode) {
        try {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'gpt-4o', messages, temperature: 0.75, max_tokens: 600, stream: false })
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            return new Response(
                JSON.stringify({ reply: data.choices?.[0]?.message?.content || '' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 502 });
        }
    }

    // ── True SSE streaming ────────────────────────────────────────────────────
    try {
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages,
                temperature: 0.75,
                max_tokens: 500,
                stream: true
            })
        });

        if (!openaiRes.ok) {
            const err = await openaiRes.text();
            return new Response(`data: ${JSON.stringify({ error: err })}\n\n`, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
            });
        }

        // Pipe OpenAI SSE → client SSE via TransformStream
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        // Async pump — runs concurrently with the Response being sent
        (async () => {
            const reader = openaiRes.body.getReader();
            let buf = '';
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop(); // keep incomplete line
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
                        } catch (_) {}
                    }
                }
            } catch (e) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
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

    } catch (err) {
        return new Response(`data: ${JSON.stringify({ error: err.message })}\n\n`, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
        });
    }
};

export const config = { path: '/api/chat' };
