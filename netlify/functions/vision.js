// ── Vision Analysis ──────────────────────────────────
// POST { imageUrl } → { description }
// Uses GPT-4o-mini vision to describe an image in plain language.
// Stored alongside the media so the AI can reference what was in the image.

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let imageUrl;
    try {
        ({ imageUrl } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!imageUrl) return { statusCode: 400, body: JSON.stringify({ error: 'imageUrl required' }) };

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                max_tokens: 200,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Describe this image in 1–3 natural sentences. Be specific: mention what objects, people, places, food, or atmosphere you see. Write as if a friend is casually describing a photo — no formal tone, no "I see..."'
                        },
                        {
                            type: 'image_url',
                            image_url: { url: imageUrl, detail: 'low' }
                        }
                    ]
                }]
            })
        });

        const data = await res.json();
        if (!res.ok) {
            console.error('OpenAI vision error:', data);
            return { statusCode: 200, body: JSON.stringify({ description: 'An image was shared.' }) };
        }

        const description = data.choices?.[0]?.message?.content?.trim() || 'An image was shared.';
        return { statusCode: 200, body: JSON.stringify({ description }) };
    } catch (e) {
        console.error('Vision handler error:', e);
        return { statusCode: 200, body: JSON.stringify({ description: 'An image was shared.' }) };
    }
};
