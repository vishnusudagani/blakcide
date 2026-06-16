// Listener AI Copilot — returns response suggestions to the listener dashboard
// via the open-source LLM router (no OpenAI). ESM (.mjs) named export.
// The listener sends the connected user's profile + session context privately;
// suggestions are NEVER shown to the user.

import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';

export const handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

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
        // Open-source router (Gemini → Qwen hosts → Groq Llama floor). No OpenAI.
        const { text } = await chatCompleteFailover(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: listenerQuestion },
            ],
            { temperature: 0.6, maxTokens: 400 },
        );
        return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: text || '' }) };
    } catch (e) {
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
};
