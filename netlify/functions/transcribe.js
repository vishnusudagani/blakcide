exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    const { audioBase64, mimeType } = JSON.parse(event.body);
    
    try {
        // Convert Base64 back to an audio blob on the server
        const buffer = Buffer.from(audioBase64, 'base64');
        const blob = new Blob([buffer], { type: mimeType });
        
        const form = new FormData();
        form.append('file', blob, 'audio.webm');
        form.append('model', 'whisper-1');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body: form
        });
        
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server Error' }) };
    }
};