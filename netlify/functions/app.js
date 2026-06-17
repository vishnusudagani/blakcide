// Persona quick-chat (/api/chat) — free open-source LLM via Groq (Llama 3.3 70B).
// Groq's API is OpenAI-compatible, so this is a drop-in for the old OpenAI call.
// No paid OpenAI. Returns { reply }.
exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let messages;
    try { ({ messages } = JSON.parse(event.body || '{}')); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    if (!Array.isArray(messages) || messages.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'messages[] required' }) };
    }

    const GROQ_KEY = process.env.GROQ_API_KEY || '';
    if (!GROQ_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured' }) };
    const MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_KEY}`,
            },
            body: JSON.stringify({
                model: MODEL,
                messages,
                temperature: 0.5,
                max_tokens: 250,
            }),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error('Groq chat error:', response.status, errText);
            return { statusCode: 502, body: JSON.stringify({ error: 'upstream_' + response.status }) };
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || 'I am here for you.';
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply }) };
    } catch (error) {
        console.error('app.js handler error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server Error' }) };
    }
};
