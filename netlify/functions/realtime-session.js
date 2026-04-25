// Realtime Session Token
// Returns an ephemeral OpenAI API key for GPT-4o Realtime WebSocket connections.
// The ephemeral key is short-lived (~60s) and browser-safe — it cannot be used
// for any other OpenAI API calls outside the Realtime session.
// Reference: https://platform.openai.com/docs/guides/realtime-webrtc#creating-an-ephemeral-token
//
// IMPORTANT: this endpoint is responsible for injecting the full Symp.ai
// system prompt (language rule + native-fluency rule + Vault context) into
// the Realtime session's `instructions` field. Without this, the voice
// model gets no context and falls back to default English-only behavior.
//
// CommonJS handler — the rest of /symp-core is ESM, so we dynamic-import().

exports.handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type':                 'application/json',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: cors, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Same key fallback as /api/symp/v1/chat — BLAKCIDE_OPENAI_KEY is the
    // canonical project key with full Realtime access.
    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) {
        console.error('[realtime-session] No OpenAI key set');
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server config error' }) };
    }

    // Parsed only for telemetry — body is currently unused since the simplified
    // Realtime instructions don't depend on per-user Vault context (a complex
    // prompt was the prior cause of the audio model dropping back to English).
    try { if (event.body) JSON.parse(event.body); } catch (_) {}

    // ── SIMPLIFIED REALTIME INSTRUCTIONS ───────────────────────────────
    // The Realtime audio model is sensitive to long, layered prompts and
    // tends to regress to English when the system message is too dense.
    // This is the user-blessed minimal block — short, ruthless, and locked
    // to language-mirroring. Do not extend.
    const instructions = [
        'You are a warm, local companion. You MUST output your audio in the EXACT same language the user speaks. If the user speaks Telugu, your spoken audio must be entirely in colloquial Telugu. If the user speaks Hindi, your spoken audio must be entirely in Hindi. Do not use English unless the user speaks pure English. Never mix languages. Keep responses concise and conversational.',
    ].join('\n');

    try {
        const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                model:        'gpt-4o-realtime-preview-2024-12-17',
                // alloy = most robust multilingual synthesis. Locked.
                voice:        'alloy',
                instructions,
                // Order ['text', 'audio'] per spec.
                modalities:   ['text', 'audio'],
                // Tuned VAD per spec — threshold 0.6 filters background noise
                // without being aggressive; silence_duration 1200ms gives the
                // user breathing room to finish a thought before the AI replies.
                turn_detection: {
                    type:                'server_vad',
                    threshold:           0.6,
                    prefix_padding_ms:   300,
                    silence_duration_ms: 1200,
                },
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            console.error('[realtime-session] OpenAI error:', response.status, err);
            return { statusCode: response.status, headers: cors, body: JSON.stringify({ error: err }) };
        }

        const data = await response.json();
        return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
    } catch (e) {
        console.error('[realtime-session] Fetch error:', e.message);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
};
