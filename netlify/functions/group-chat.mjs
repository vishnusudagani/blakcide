// ─── BLAKCIDE Group Chat — AI Mediator ──────────────────────────────────────
//
// POST /api/group-chat
// Body: {
//   messages : [{ userId, userName, role: 'user'|'assistant', content }]
//   language ?: 'en' | 'hi' | 'te'   (detected from latest message)
// }
// → { reply: string }
//
// The AI receives the full shared conversation history and responds as a
// neutral mediator/friend — referencing users by name, never taking sides.
//
// Language enforcement:
//   The function injects a language instruction matching the detected language
//   of the most recent user message so the AI mirrors the active language.

const GROUP_MEDIATOR_PROMPT = `You are Blakcide — an emotionally intelligent friend sitting in a group chat with two people.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR ROLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are NOT a moderator or a therapist. You are their mutual friend who:
• Listens to BOTH sides equally
• References each person by their name naturally ("I think Vishnu has a point here but Rahul's concern makes sense too")
• Never takes a side without good reason
• When they debate → helps them find common ground, gently challenges extreme views
• When they ask questions → answers both clearly without favouring one
• When one person vents → acknowledges them while keeping the other person in the loop
• Keeps energy light and human unless the topic is serious

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Short replies — 2–4 sentences max. Group chat, not a monologue.
• No bullet points, lists, headers, or markdown. Plain flowing text.
• Start with a natural reaction, never "I understand" or "Certainly".
• Use names to address people specifically ("Yeah Rahul that makes sense", "Vishnu wait—")
• Warm, casual, slightly playful unless the mood calls for depth
• Never say "As an AI" or "I'm just a language model"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE LAW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Match the language of the most recent message. If they write Hindi → respond in Romanized Hindi. If Telugu → Romanized Telugu. If English → English. Never mix languages in one reply. The enforcement instruction below overrides all defaults.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HANDLING CONFLICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If they are arguing:
→ Acknowledge both perspectives in one breath
→ Find the overlap or shared intent
→ Ask a question that moves them forward ("okay but what do you both actually want here?")
→ Never declare a winner

If one person is clearly wrong on a fact → correct them gently without humiliating them.
If one person is being unkind → name it quietly ("hey, that was a bit much na?").`;

const LANG_INSTRUCTIONS = {
    te: `ACTIVE LANGUAGE = TELUGU. Reply entirely in casual Romanized Telugu (or native script if they use it). Zero Hindi. Zero formal language.`,
    hi: `ACTIVE LANGUAGE = HINDI. Reply entirely in casual Romanized Hindi (or native script if they use it). Zero Telugu. Zero formal language.`,
    en: `ACTIVE LANGUAGE = ENGLISH. Reply in casual warm English only.`,
};

// ── Simple Unicode + keyword language detector ────────────────────────────────
const TE_WORDS = new Set([
    'nenu','nuvvu','meeru','mee','ela','unnav','unnaru','undi','ledu','avunu',
    'kaadu','cheppandi','emi','endi','enduku','manchi','bagunnanu','sare','aiyo',
    'ayyo','ra','ante','ga','kadha','chestunna','anipistundi','chala','chaala',
    'enti','babu','ikkade','akkade','poyindi','vachhindi','chesanu','inkemi',
]);
const HI_WORDS = new Set([
    'kaise','kya','haan','nahi','accha','yaar','bhai','hai','hoon','mera',
    'meri','tumhara','aap','main','hum','kyun','kab','kahan','kuch','bahut',
    'bohot','theek','sahi','kal','aaj','abhi','phir','lekin','toh','tum',
    'bilkul','matlab','samjha','bolta','bolti','dost','pyaar','zindagi','dil',
    'khush','dukhi','arrey','arre','oye','chal','chalo',
]);

function detectLanguage(text) {
    if (!text) return 'en';
    const teChars = (text.match(/[\u0C00-\u0C7F]/g) || []).length;
    const hiChars = (text.match(/[\u0900-\u097F]/g) || []).length;
    const sig     = text.replace(/[\s\d\W]/g, '').length || 1;
    if (teChars / sig > 0.20) return 'te';
    if (hiChars / sig > 0.20) return 'hi';
    const words = text.toLowerCase().split(/[\s,!?.।]+/).filter(Boolean);
    let te = 0, hi = 0;
    for (const w of words) {
        if (TE_WORDS.has(w)) te += 2;
        if (HI_WORDS.has(w)) hi += 2;
        if (/[nu|ni|lo|ki|tho|ga|di|lu]$/.test(w) && w.length > 3 && !HI_WORDS.has(w)) te++;
    }
    if (te > 0 || hi > 0) return te >= hi ? 'te' : 'hi';
    return 'en';
}

export default async (req) => {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let messages, language;
    try {
        const body = await req.json();
        messages = body.messages;
        language = body.language;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('messages required');
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message || 'Invalid request' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const apiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }

    // Detect language from most recent user message if not provided
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const detectedLang = language || (lastUserMsg ? detectLanguage(lastUserMsg.content) : 'en');
    const langInstruction = LANG_INSTRUCTIONS[detectedLang] || LANG_INSTRUCTIONS.en;

    // Build OpenAI messages array
    // Format: each user message prefixed with speaker name so AI tracks who said what
    const openaiMessages = [
        { role: 'system', content: GROUP_MEDIATOR_PROMPT },
        // Convert group messages to OpenAI format with speaker attribution
        ...messages.map(m => {
            if (m.role === 'assistant') {
                return { role: 'assistant', content: m.content };
            }
            // User message — prefix with name so AI knows who's speaking
            const name = m.userName || m.userId || 'User';
            return {
                role: 'user',
                content: `[${name}]: ${m.content}`
            };
        }),
        // High-recency language enforcement injection
        { role: 'system', content: langInstruction },
    ];

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model:       'gpt-4o',
                messages:    openaiMessages,
                temperature: 0.80,
                max_tokens:  300,
                stream:      false,
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            console.error('[GroupChat] OpenAI error:', res.status, err);
            return new Response(JSON.stringify({ error: 'AI unavailable' }), {
                status: 502, headers: { 'Content-Type': 'application/json' }
            });
        }

        const data  = await res.json();
        const reply = data.choices?.[0]?.message?.content || '';

        return new Response(JSON.stringify({ reply, language: detectedLang }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });

    } catch (e) {
        console.error('[GroupChat] Handler error:', e);
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
};

export const config = { path: '/api/group-chat' };
