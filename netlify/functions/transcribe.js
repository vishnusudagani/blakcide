exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let audioBase64, mimeType;
    try {
        ({ audioBase64, mimeType } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!audioBase64) return { statusCode: 400, body: JSON.stringify({ error: 'audioBase64 required' }) };

    // Derive file extension from mimeType so Whisper infers the right format
    const ext = !mimeType       ? 'webm'
              : mimeType.includes('mp4')  ? 'm4a'
              : mimeType.includes('mpeg') ? 'mp3'
              : mimeType.includes('ogg')  ? 'ogg'
              : mimeType.includes('wav')  ? 'wav'
              :                             'webm';
    const filename    = `audio.${ext}`;
    const contentType = mimeType || 'audio/webm';

    try {
        const buffer = Buffer.from(audioBase64, 'base64');
        const form   = new FormData();
        form.append('file',  new Blob([buffer], { type: contentType }), filename);
        form.append('model', 'whisper-1');
        // language hint improves accuracy for Indian English / Romanized Telugu / Hindi
        form.append('language', 'en');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body:    form
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error('Whisper API error:', response.status, errText);
            return { statusCode: 200, body: JSON.stringify({ text: '' }) };
        }

        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify({ text: data.text || '' }) };
    } catch (error) {
        console.error('Transcribe handler error:', error);
        return { statusCode: 200, body: JSON.stringify({ text: '' }) };
    }
};
