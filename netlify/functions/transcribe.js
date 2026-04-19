const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
    }

    let audioBase64, mimeType, langHint;
    try {
        ({ audioBase64, mimeType, langHint } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!audioBase64) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'audioBase64 required' }) };

    const ext = !mimeType              ? 'webm'
              : mimeType.includes('mp4')   ? 'm4a'
              : mimeType.includes('mpeg')  ? 'mp3'
              : mimeType.includes('ogg')   ? 'ogg'
              : mimeType.includes('wav')   ? 'wav'
              :                              'webm';
    const filename    = `audio.${ext}`;
    const contentType = mimeType || 'audio/webm';

    try {
        const buffer = Buffer.from(audioBase64, 'base64');
        const form   = new FormData();
        form.append('file',  new Blob([buffer], { type: contentType }), filename);
        form.append('model', 'whisper-1');
        // If we already know the user's language (te/hi), pass it as a hint.
        // This makes Whisper output NATIVE SCRIPT (తెలుగు / हिंदी) instead of Romanized Latin.
        // Without a hint, Whisper often outputs "nenu bagunnanu" instead of "నేను బాగున్నాను".
        if (langHint && langHint !== 'en') {
            form.append('language', langHint);
        }
        // verbose_json returns the detected language code alongside the transcript
        form.append('response_format', 'verbose_json');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY}` },
            body:    form
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error('Whisper API error:', response.status, errText);
            return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: '', language: null }) };
        }

        const data = await response.json();
        return {
            statusCode: 200,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text:     data.text     || '',
                language: data.language || null,
            })
        };
    } catch (error) {
        console.error('Transcribe handler error:', error);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: '', language: null }) };
    }
};
