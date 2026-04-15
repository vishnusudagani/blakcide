// Netlify Functions v2 — OpenAI proxy (gpt-4o)
export default async (req) => {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let messages;
    try {
        const body = await req.json();
        messages = body.messages;
        if (!messages || !Array.isArray(messages)) throw new Error('No messages');
    } catch(e) {
        return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages,
                temperature: 0.75,
                max_tokens: 400,
                stream: true
            })
        });

        if (!openaiRes.ok) {
            const errText = await openaiRes.text();
            console.error('OpenAI error:', errText);
            return new Response(JSON.stringify({ error: 'AI unavailable', detail: errText }), {
                status: 502, headers: { 'Content-Type': 'application/json' }
            });
        }

        const reader  = openaiRes.body.getReader();
        const decoder = new TextDecoder();
        let full = '', buf = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const p = t.slice(5).trim();
                if (p === '[DONE]') continue;
                try { full += JSON.parse(p).choices?.[0]?.delta?.content || ''; } catch(_) {}
            }
        }

        return new Response(JSON.stringify({ reply: full || 'I am here for you.' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });

    } catch(err) {
        console.error('chat-stream error:', err);
        return new Response(JSON.stringify({ error: 'Server error', detail: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
};

export const config = { path: '/api/chat' };
