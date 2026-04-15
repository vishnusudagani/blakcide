// ── Chat / Call Summarizer ────────────────────────────
// POST { messages: [{role, content}], type: 'chat'|'call', imageDescriptions: [] }
// → { title, content }
// Generates a personal journal entry from an AI chat or call transcript.

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let messages, type, imageDescriptions;
    try {
        ({ messages, type = 'chat', imageDescriptions = [] } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!messages || messages.length < 2) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Not enough messages to summarize' }) };
    }

    // Build readable conversation text — skip image markers in the transcript
    const convoText = messages
        .filter(m => m.content && !m.content.startsWith('IMAGE::') && !m.content.startsWith('AUDIO::'))
        .map(m => {
            const speaker = m.role === 'user' ? 'Me' : 'AI Companion';
            return `${speaker}: ${m.content}`;
        })
        .join('\n');

    const imageCtx = imageDescriptions.length
        ? `\n\nImages shared during the session:\n${imageDescriptions.map(d => `• ${d}`).join('\n')}`
        : '';

    const sessionType = type === 'call' ? 'voice call' : 'text conversation';

    const prompt = `You are helping someone write a personal journal entry about a ${sessionType} they just had with their AI mental health companion, Blakcide.

Write a warm, reflective journal entry from the user's perspective — as if they are writing in their own diary after the session. Be personal and introspective, not clinical.

Include:
- The main themes, feelings, or topics that came up
- Any insights, realisations, or shifts in perspective
- Something they might want to remember or act on
${imageCtx ? '- Naturally reference any images they shared (e.g. "I shared a photo of...")' : ''}

The conversation:
${convoText}${imageCtx}

Respond ONLY with valid JSON in this format:
{ "title": "3–6 word personal title", "content": "2–4 paragraph journal entry, warm and personal, written in first person" }`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                temperature: 0.72,
                max_tokens: 600,
                response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await res.json();
        if (!res.ok) {
            console.error('OpenAI summarize error:', data);
            return { statusCode: 500, body: JSON.stringify({ error: 'AI error' }) };
        }

        const raw = data.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);

        return {
            statusCode: 200,
            body: JSON.stringify({
                title: parsed.title || `${type === 'call' ? 'Voice Call' : 'AI Chat'} Session`,
                content: parsed.content || ''
            })
        };
    } catch (e) {
        console.error('Summarize handler error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
