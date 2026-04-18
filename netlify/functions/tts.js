// OpenAI Neural TTS proxy
// POST { text: string, voice?: string }
// → audio/mpeg binary (base64-encoded)

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let text, voice;
    try {
        ({ text, voice = 'nova' } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!text || !text.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };
    }

    // Trim to reasonable length — very long responses are chunked on client side
    const trimmed = text.trim().substring(0, 500);

    const apiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'TTS key not configured' }) };
    }

    try {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'tts-1',          // tts-1 is fast; tts-1-hd is higher quality but slower
                input: trimmed,
                voice: voice,            // nova (warm female) — best for companion feel
                response_format: 'mp3',
                speed: 1.0
            })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error('OpenAI TTS error:', err);
            return { statusCode: 502, body: JSON.stringify({ error: 'TTS unavailable', detail: err }) };
        }

        const buffer = await res.arrayBuffer();
        const base64Audio = Buffer.from(buffer).toString('base64');

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'audio/mpeg',
                'Cache-Control': 'no-store'
            },
            body: base64Audio,
            isBase64Encoded: true
        };
    } catch(e) {
        console.error('TTS handler error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
