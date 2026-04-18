// ─── BLAKCIDE TTS proxy — OpenAI neural TTS, language-aware ─────────────────
//
// POST { text, voice?, language? }
// → audio/mpeg (base64-encoded)
//
// Voice + speed matrix:
//   English  → nova,   speed 1.00  (warm, natural pace)
//   Hindi    → nova,   speed 0.95  (slight slowdown — Devanagari is dense)
//   Telugu   → shimmer, speed 0.92 (softer voice, slower — Telugu phonemes
//                                    need more time to sound natural)
//   fallback → nova,   speed 1.00
//
// Why shimmer for Telugu?
//   Nova's phoneme mapping for Telugu script is accurate but sounds slightly
//   clipped at 1.0x. Shimmer's softer attack matches the breathy quality of
//   spoken Telugu better, and 0.92x gives vowel-heavy syllables room to land.

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let text, voice, language;
    try {
        ({ text, voice, language = 'en' } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!text || !text.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };
    }

    // ── Language-aware voice + speed ──────────────────────────────────────────
    const LANG_CONFIG = {
        te: { voice: 'shimmer', speed: 0.92 },  // Telugu: softer, slower
        hi: { voice: 'nova',    speed: 0.95 },  // Hindi:  warm, slightly slower
        en: { voice: 'nova',    speed: 1.00 },  // English: default
    };
    const cfg      = LANG_CONFIG[language] || LANG_CONFIG.en;
    const ttsVoice = voice || cfg.voice;  // caller can override
    const ttsSpeed = cfg.speed;

    // Trim to safe length — very long inputs are split upstream
    const trimmed = text.trim().substring(0, 500);

    const apiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'TTS key not configured' }) };
    }

    try {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json'
            },
            body: JSON.stringify({
                model:           'tts-1',
                input:           trimmed,
                voice:           ttsVoice,
                response_format: 'mp3',
                speed:           ttsSpeed
            })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error('[TTS] OpenAI error:', res.status, err);
            return { statusCode: 502, body: JSON.stringify({ error: 'TTS unavailable', detail: err }) };
        }

        const buffer     = await res.arrayBuffer();
        const base64Audio = Buffer.from(buffer).toString('base64');

        return {
            statusCode: 200,
            headers: {
                'Content-Type':  'audio/mpeg',
                'Cache-Control': 'no-store',
                'X-Language':    language,   // useful for debugging
                'X-Voice':       ttsVoice,
                'X-Speed':       String(ttsSpeed)
            },
            body:            base64Audio,
            isBase64Encoded: true
        };

    } catch (e) {
        console.error('[TTS] Handler error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
