// Realtime Session Token
// Returns an ephemeral OpenAI API key for GPT-4o Realtime WebSocket connections,
// with the FULL Unified Soul instruction stack injected server-side.
//
// Why server-side:
//   - We don't trust the browser to pick the persona / inject vault context.
//   - Keeping the canonical voice config in one place means it can never
//     drift between server and client.
//
// The browser also sends a `session.update` after connecting (see app.js
// _rtUpdateSession()) — the two MUST ship identical config or the client
// will clobber the ephemeral one and regress voice quality. The shared
// constants block at the top of this file is mirrored exactly in app.js.
//
// CommonJS handler — the rest of /symp-core is ESM, so we dynamic-import().

const VOICE   = 'alloy';        // multilingual synthesis — locked
const VAD = {
    type:                'server_vad',
    threshold:           0.6,
    prefix_padding_ms:   300,
    silence_duration_ms: 1200,
};

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

    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) {
        console.error('[realtime-session] No OpenAI key set');
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server config error' }) };
    }

    // Parse body for user_id (optional). The browser proxy is responsible for
    // overriding this with the JWT-derived id; here we just consume what the
    // proxy hands us.
    let userId = null;
    try {
        if (event.body) {
            const body = JSON.parse(event.body);
            userId = body.user_id || null;
        }
    } catch (_) { /* ignore */ }

    // Build the FULL instructions stack via the shared system-prompt module.
    // ESM dynamic-import because this file is CJS but the rest of symp-core is ESM.
    let instructions = MINIMAL_FALLBACK_INSTRUCTIONS;
    let voiceTools   = [];
    try {
        const sysMod = await import('../../symp-core/lib/system-prompt.mjs');
        instructions = await sysMod.buildInstructionsText(userId);
    } catch (e) {
        console.warn('[realtime-session] system-prompt import failed, using fallback:', e.message);
    }
    try {
        const toolsMod = await import('../../symp-core/lib/tools.mjs');
        voiceTools = toolsMod.VOICE_TOOL_DEFS || [];
    } catch (e) {
        console.warn('[realtime-session] tools import failed, voice without tools:', e.message);
    }

    // Realtime API expects tools flattened (no top-level `type:'function'`).
    const flattenedTools = voiceTools.map(t => ({
        type:        'function',
        name:        t.function?.name,
        description: t.function?.description,
        parameters:  t.function?.parameters,
    }));

    try {
        const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                model:          'gpt-4o-realtime-preview-2024-12-17',
                voice:           VOICE,
                instructions,
                modalities:     ['text', 'audio'],
                turn_detection:  VAD,
                tools:           flattenedTools,
                tool_choice:    'auto',
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            console.error('[realtime-session] OpenAI error:', response.status, err);
            return { statusCode: response.status, headers: cors, body: JSON.stringify({ error: err }) };
        }

        const data = await response.json();
        // Echo back the canonical config so the browser can mirror exactly.
        // (app.js compares + emits its own session.update; they must match.)
        data._symp_canonical_config = {
            voice:           VOICE,
            modalities:     ['text', 'audio'],
            turn_detection:  VAD,
            instructions,    // full stack — browser uses this verbatim
            tools:           flattenedTools, // full defs so the browser can replay
        };
        return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
    } catch (e) {
        console.error('[realtime-session] Fetch error:', e.message);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
};

// Minimal fallback if the shared system-prompt module fails to load — keeps
// the call usable even if a deploy goes sideways.
const MINIMAL_FALLBACK_INSTRUCTIONS = [
    'You are a warm, local digital companion. You MUST output your audio in the EXACT same language the user speaks.',
    'If the user speaks Telugu, your spoken audio must be entirely in colloquial Telugu.',
    'If the user speaks Hindi, your spoken audio must be entirely in Hindi.',
    'Never mix languages. Keep responses concise and conversational.',
    'If asked if you are human, be honest but warm: "I live in your phone, but I\'m always here for you."',
].join('\n');
