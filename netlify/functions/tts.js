// ─── BLAKCIDE TTS proxy — open-source voice-infer (OmniVoice / Indic Parler) ──
//
// POST { text, language?, voice?, referenceUrl?, referenceTranscript? }
// → audio/mpeg (base64-encoded)
//
// Routes to the self-hosted voice-infer service (all engines Apache-2.0 / MIT).
// No OpenAI.
//   - Default: mode 'preset'  → Blak's designed voice (Indic Parler), per language.
//   - referenceUrl supplied: mode 'clone' → the user's own voice (Real Persona).
//
// Requires env:
//   VOICE_INFER_URL     — base URL of the deployed voice-infer service (Modal)
//   VOICE_INFER_SECRET  — shared secret, sent as the X-Infer-Secret header
//
// Until voice-infer is deployed, this returns 503 by design — we do NOT fall
// back to OpenAI. Voice output is open-source or nothing.

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let text, voice, language, referenceUrl, referenceTranscript;
    try {
        ({ text, voice, language = 'en', referenceUrl, referenceTranscript } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!text || !text.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };
    }

    const VOICE_INFER_URL    = process.env.VOICE_INFER_URL;
    const VOICE_INFER_SECRET = process.env.VOICE_INFER_SECRET || '';
    if (!VOICE_INFER_URL) {
        return {
            statusCode: 503,
            body: JSON.stringify({
                error:  'TTS not configured',
                detail: 'VOICE_INFER_URL is not set — deploy the voice-infer service (Modal) to enable open-source voice output.',
            }),
        };
    }

    // Blak's designed voice (Indic Parler description). Override via env / caller.
    const blakVoice = voice || process.env.BLAK_VOICE_DESCRIPTION ||
        'A warm, friendly young adult with a calm, reassuring, conversational tone, speaking clearly at a natural pace in a quiet room.';

    // voice-infer caps at 2000 chars; long replies are chunked upstream.
    const trimmed = text.trim().substring(0, 2000);
    const isClone = !!referenceUrl;

    const payload = isClone
        ? { language, text: trimmed, format: 'mp3', mode: 'clone', reference_url: referenceUrl, reference_transcript: referenceTranscript }
        : { language, text: trimmed, format: 'mp3', mode: 'preset', preset_description: blakVoice };

    try {
        const res = await fetch(`${VOICE_INFER_URL.replace(/\/$/, '')}/synthesize`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-Infer-Secret': VOICE_INFER_SECRET },
            body:    JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text().catch(() => '');
            console.error('[TTS] voice-infer error:', res.status, err);
            return { statusCode: 502, body: JSON.stringify({ error: 'TTS unavailable', detail: err.slice(0, 200) }) };
        }

        const buffer      = await res.arrayBuffer();
        const base64Audio = Buffer.from(buffer).toString('base64');

        return {
            statusCode: 200,
            headers: {
                'Content-Type':  'audio/mpeg',
                'Cache-Control': 'no-store',
                'X-Language':    language,
                'X-Voice-Mode':  isClone ? 'clone' : 'preset',
            },
            body:            base64Audio,
            isBase64Encoded: true,
        };

    } catch (e) {
        console.error('[TTS] Handler error:', e);
        return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
    }
};
