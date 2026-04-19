// Listener AI Copilot — returns GPT-4o suggestions to the listener dashboard.
// ESM format (.mjs) — uses named export instead of CommonJS exports.handler.
// The listener sends the connected user's profile + session context privately.

export const handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server config error' }) };

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Bad JSON' }) };
    }

    const {
        listenerQuestion = '',
        userProfile      = {},
        recentMessages   = [],
    } = body;

    if (!listenerQuestion.trim()) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Question required' }) };
    }

    const profileContext = [
        userProfile.full_name ? `User name: ${userProfile.full_name}` : null,
        userProfile.bio       ? `User bio: ${userProfile.bio}`         : null,
        userProfile.user_memory && userProfile.user_memory.trim()
            ? `User memory / recurring themes:\n${userProfile.user_memory}` : null,
        userProfile.recent_journals && userProfile.recent_journals.length
            ? `Recent journal snippets (last 3):\n${userProfile.recent_journals
                .map((j, i) => `[${i+1}] ${j.title}: ${(j.content||'').slice(0,300)}`)
                .join('\n')}` : null,
    ].filter(Boolean).join('\n\n');

    const sessionContext = recentMessages.length
        ? recentMessages.map(m => `${m.role === 'user' ? 'User' : 'Listener'}: ${m.content}`).join('\n')
        : '(no messages yet — session just started)';

    const systemPrompt = `You are a private AI assistant embedded in a mental-wellness listener's dashboard.
Your sole job is to help the listener respond with empathy, insight, and relevance.
Your suggestions are NEVER shown to the user.

RULES:
- Suggest short, actionable responses the listener can use or adapt.
- If the user seems to be in distress, flag it and suggest a gentle check-in.
- Cite specific details from the user's profile/journals to personalise suggestions.
- Keep answers under 200 words. Use bullet points for multiple suggestions.
- Never fabricate clinical diagnoses.

--- CONNECTED USER PROFILE ---
${profileContext || '(no profile data available)'}

--- CURRENT SESSION TRANSCRIPT ---
${sessionContext}`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-4o',
                max_tokens: 400,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: listenerQuestion },
                ],
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            return { statusCode: res.status, headers: cors, body: JSON.stringify({ error: err }) };
        }

        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content || '';
        return { statusCode: 200, headers: cors, body: JSON.stringify({ reply }) };
    } catch (e) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
};
