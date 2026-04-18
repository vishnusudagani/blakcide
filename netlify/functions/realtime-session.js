// Realtime Session Token
// Returns an ephemeral OpenAI API key for GPT-4o Realtime WebSocket connections.
// The ephemeral key is short-lived (~60s) and browser-safe — it cannot be used
// for any other OpenAI API calls outside the Realtime session.
// Reference: https://platform.openai.com/docs/guides/realtime-webrtc#creating-an-ephemeral-token

exports.handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: cors, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
        console.error('[realtime-session] OPENAI_API_KEY not set');
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server config error' }) };
    }

    try {
        const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o-realtime-preview-2024-12-17',
                voice: 'verse',
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
