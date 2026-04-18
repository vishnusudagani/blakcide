exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let audioBase64, mimeType;
    try {
        ({ audioBase64, mimeType } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!audioBase64) return { statusCode: 400, body: JSON.stringify({ error: 'audioBase64 required' }) };

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
        // NO language hint — let Whisper auto-detect Telugu / Hindi / English
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
            return { statusCode: 200, body: JSON.stringify({ text: '', language: null }) };
        }

        const data = await response.json();
        // verbose_json returns { text, language, segments, ... }
        // language is ISO-639-1 code: 'en', 'te', 'hi', etc.
        return {
            statusCode: 200,
            body: JSON.stringify({
                text:     data.text     || '',
                language: data.language || null   // e.g. 'te', 'hi', 'en'
            })
        };
    } catch (error) {
        console.error('Transcribe handler error:', error);
        return { statusCode: 200, body: JSON.stringify({ text: '', language: null }) };
    }
};
