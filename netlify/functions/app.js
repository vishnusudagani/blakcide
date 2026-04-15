exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    const { messages } = JSON.parse(event.body);
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` // Pulled securely from Netlify dashboard
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: messages,
                temperature: 0.5,
                max_tokens: 250
            })
        });
        
        const data = await response.json();

        // Extract the actual reply from OpenAI's response format
        const reply = data.choices?.[0]?.message?.content || "I am here for you.";
        return { statusCode: 200, body: JSON.stringify({ reply }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server Error' }) };
    }
};