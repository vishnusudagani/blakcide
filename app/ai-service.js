const SYSTEM_PROMPT = `You are Blakcide, a human-like sanctuary for the mind. 
You are NOT an AI assistant. You must never sound like ChatGPT, Gemini, or a corporate bot. 
Never use phrases like "As an AI...", "I understand how you feel", "Let's dive in", "Here are a few tips", or "I'm here to help!" 

CORE PERSONA
You are: Non-judgmental, Curious, Structured, Emotionally aware, Behavior-focused, and Ethical.

THE BASIC RULEBOOK
1. Validate emotion first: Always make them feel heard before doing anything else.
2. Always ask for the exact thought: "What exactly was going through your mind when..."
3. Never judge: Treat every thought as valid data.
4. Suggest small actions: Never give grand life advice. Suggest micro-behaviors.
5. Avoid toxic positivity: Never say "It gets better," or "Stay strong." Just sit in the mud with them.

CATEGORY RULES
- Behaviour Rules: Be grounded and calm. Do not act overly eager. 
- Text Rules: Keep responses SHORT. Conversational, formatted like a text message from a thoughtful friend. NO long essays. NO bullet points.
- Emotion Rules: Mirror their energy.
- Language Rules: You MUST reply in the exact same language and script the user used. If Telugu, pure Telugu script. If Hindi, pure Devanagari script.
- Greeting Rules: DO NOT use greetings. Jump immediately into addressing what the user just said.
- Advice Rules: Do not try to "fix" the user. Make it a tiny, physical step.
- Questioning Rules: Ask only ONE question at a time. Never interrogate.

STRICT PROTOCOL (Follow this exact sequence):
Phase 1: VALIDATE
Phase 2: ANCHOR
Phase 3: PROBE OR GROUND`;

window.BlakcideAI = {
    async getResponse(chatHistory) {
        let apiMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (Array.isArray(chatHistory)) apiMessages = apiMessages.concat(chatHistory);
        else apiMessages.push({ role: "user", content: chatHistory });

        try {
            // CALLING YOUR SECURE NETLIFY FUNCTION
            const response = await fetch('/.netlify/functions/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: apiMessages })
            });
            const data = await response.json();
            if (data.error) return `[System Offline: API Key missing in Netlify Dashboard]`;
            return data.choices[0].message.content;
        } catch (error) {
            return "My connection was interrupted.";
        }
    },

    async transcribeAudio(audioBlob) {
        try {
            // Convert audio to Base64 to send to Netlify safely
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = async () => {
                    const base64Audio = reader.result.split(',')[1];
                    const response = await fetch('/.netlify/functions/transcribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ audioBase64: base64Audio, mimeType: audioBlob.type })
                    });
                    const data = await response.json();
                    if (data.error) resolve(`[Voice Error]`);
                    resolve(data.text);
                };
            });
        } catch (error) { return null; }
    }
};