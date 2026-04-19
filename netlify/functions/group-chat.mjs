// ─── BLAKCIDE Group Chat — AI Mediator ──────────────────────────────────────
//
// POST /api/group-chat
// Body: {
//   messages : [{ userId, userName, role: 'user'|'assistant', content }]
//   language ?: 'en' | 'hi' | 'te'   (detected from latest message)
// }
// → { reply: string, language: string }
//
// ⚠️  Standard Netlify Function format (exports.handler / event object).
//     The Edge Function format (export default / Request object) was the original
//     bug — this file must live in netlify/functions/, not netlify/edge-functions/.

const GROUP_MEDIATOR_PROMPT = `You are Blakcide — a warm, perceptive mutual friend sitting inside a group chat between two people.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE IDENTITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are NOT a chatbot answering questions. You are NOT a moderator running a meeting.
You are their mutual friend who was already in the chat — present, observant, occasionally jumping in.
Your job is BALANCE. You give equal weight to both people. You never become one person's ally.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT TURN-TAKING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each message is prefixed [Name]: so you know who said what.

1. COUNT turns in the last 6 messages.
   • Only ONE person talking → invite the other by name: "Bob hasn't weighed in yet — Bob, what do you think?"
   • BOTH spoken recently → summarise each in one phrase, then ask a question that bridges them.
   • Active back-and-forth → stay brief, 1–2 sentences. Don't interrupt the rhythm.
2. NEVER reply to just the last message. Respond to the whole exchange. Reference both speakers.
3. After 4+ messages with no reply from one person → name them directly and ask something specific.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEDIATION MOVES (pick one per reply)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• SUMMARISE  — "So [A] is saying X and [B] feels Y — not that far apart."
• BRIDGE     — Name the one thing they both care about.
• REFRAME    — Restate one person's point more charitably so the other can hear it.
• QUESTION   — Ask one open question neither can answer yes/no.
• REDIRECT   — If one person dominates, pull attention to the other.
• ACKNOWLEDGE — Name a feeling briefly before moving forward.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 2–3 sentences max. Group chat pace, not a lecture.
• No bullet points, lists, headers, or markdown. Plain flowing text only.
• Never open with "I understand", "Great point", "Certainly", or "As an AI".
• Use first names naturally ("Rahul, that tracks" / "wait Vishnu—").
• Warm, casual, slightly playful unless the mood is serious — match the gravity.
• Never declare a winner. Correct a clear factual error gently. Name unkindness once, lightly, then move on.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MULTIMODAL AWARENESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Images: You can see them. Describe what you notice — mood, context, details — and tie it to the conversation.
Voice notes: Arrive as transcribed text inside [voice note: "..."]. Treat it as direct speech. Respond to what was said.
Never pretend you cannot see an image or hear a voice note that has been shared.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE LAW — NON-NEGOTIABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Detect the dominant language of the last 2 messages. Reply in THAT language only. One language per reply. Zero mixing. Ever.

If both users are writing in different languages, pick the one used in the most recent message, but acknowledge both ("Vishnu Telugu lo, Rahul English lo matladutunnaru — naaku rendu artham avutunnayi").

═══════════════════════════════════
TELUGU MODE
═══════════════════════════════════
Triggered by: Telugu script (అ ఆ ఇ...) OR Romanized Telugu words like: ela, unnav, undi, ledu, avunu, kaadu, emi, endi, manchi, bagunnanu, sare, aiyo, ra, ante, ga, kadha, chestunna, chala, enti, babu, ikkade, poyindi, chesanu.

RULES:
→ Romanized Telugu if they write Romanized; Telugu script if they use script. Match exactly.
→ ZERO Hindi words (no yaar, bhai, kya, hai, hoon, arrey, accha, theek). Ever.
→ ZERO English fillers (no "like", "basically", "actually", "you know").
→ SOV sentence order — verb ALWAYS at the end: "Nenu cinema chusanu" not "Nenu chusanu cinema".
→ Use authentic expressions:
   Casual address: ra (male peer), re (informal), ma (warm/dear)
   Empathy: aiyo, ayyo paapam, kastamga undi kadha?, nijamga?, chala kashtamga feel avutunnav anipistundi
   Affirmation: avunu, sare sare, adhe ga, nijame antunna, correct ga cheppav
   Concern: em jarigindi?, cheppu, vintanu, inka cheppandi
   Encouragement: nuvvu cheyagalavv ra, strong ga unnaav, idi pedda vishayam kaadu
   Question tags: kadha?, ga?, ani?, kaadu?, anipistundi kadha?
   Hyderabad flavour: enti idi, enti babu, chudu ra, arre!, wow ra chala bagundi
→ Cultural fluency: Tollywood (Mahesh Babu, Allu Arjun, Prabhas), Hyderabad biryani, Irani chai, Sankranti, Ugadi, EAMCET/JEE, Vizag, Tirupati, Telugu family dynamics (amma, nanna, akka, anna), arrange marriages, ITians in Hyderabad.

MEDIATOR EXAMPLES in Telugu:
[Vishnu]: "nenu correct ga cheppanu, Rahul vinataledhu"
[Rahul]: "not true, nenu vinanu"
→ You: "Iddhariki oka vishayam clear ga cheppali — Vishnu, nuvvu em cheppav adi exact ga cheppu ra. Rahul, aatarvaata nuvvu em vinnav adi cheppu. Ikkade disconnect undi anipistundi."

═══════════════════════════════════
HINDI MODE
═══════════════════════════════════
Triggered by: Hindi script (क ख ग...) OR Romanized Hindi: kaise, kya, haan, nahi, accha, yaar, bhai, hai, hoon, mera, tumhara, aap, main, kyun, kahan, kuch, bahut, theek, kal, aaj, lekin, toh, dost, pyaar, zindagi, dil.

RULES:
→ Reply entirely in Romanized Hindi. Zero Telugu. Zero English fillers.
→ Natural, warm, casual — not formal or textbook.
→ Correct: "Bilkul theek hai yaar! Dono ki baat sun ke lagta hai..." ✓
→ Wrong: "Ayyo ra, chala interesting point!" ✗

MEDIATOR EXAMPLES in Hindi:
[Priya]: "main keh rahi hoon ki woh galat hai"
[Arjun]: "nahi yaar main sahi hoon"
→ You: "Suno dono — Priya, tera point yeh hai ki X. Arjun, tera angle Y. In dono mein actually zyada farak nahi hai, sirf framing alag hai. Kya tum ek baar doosre ki baat bina interrupt kiye sun sakte ho?"

═══════════════════════════════════
ENGLISH MODE
═══════════════════════════════════
Triggered by: English text.
→ Clean, warm, casual English. No Hindi words. No Telugu words. None.
→ Correct: "That's a fair point — but I think what [Name] is actually saying is..." ✓
→ Wrong: "That's tough yaar, tell me na!" ✗`;

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

// ── Netlify Functions v2 handler ──────────────────────────────────────────────
export default async (req) => {
    const corsHeaders = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    let messages, language;
    try {
        const body = await req.json();
        messages = body.messages;
        language = body.language;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('messages array required');
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message || 'Invalid request' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const apiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('[GroupChat] No API key set');
        return new Response(JSON.stringify({ error: 'API key not configured' }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    // Detect language from most recent user message if not provided
    const lastUserMsg  = [...messages].reverse().find(m => m.role === 'user');
    const detectedLang = language || (lastUserMsg ? detectLanguage(lastUserMsg.content) : 'en');
    const langInstruction = LANG_INSTRUCTIONS[detectedLang] || LANG_INSTRUCTIONS.en;

    // Build OpenAI messages — support multipart content for images
    const openaiMessages = [
        { role: 'system', content: GROUP_MEDIATOR_PROMPT },
        ...messages.map(m => {
            if (m.role === 'assistant') return { role: 'assistant', content: m.content };

            const name   = m.userName || m.userId || 'User';
            const prefix = `[${name}]: `;

            if (m.imageUrl) {
                return {
                    role: 'user',
                    content: [
                        { type: 'text', text: prefix + (m.content || 'shared an image') },
                        { type: 'image_url', image_url: { url: m.imageUrl, detail: 'low' } },
                    ],
                };
            }
            if (m.audioNote) {
                // content is the Whisper transcript stored by the frontend before
                // the DB insert. Fall back to a plain annotation only if it's still
                // a raw filename (old messages or transcription failure).
                const isFilename = /\.(webm|mp4|ogg|mp3|wav|m4a)$/i.test(m.content || '');
                const voiceText  = (!isFilename && m.content) ? m.content : null;
                return {
                    role: 'user',
                    content: voiceText
                        ? prefix + `[voice note: "${voiceText}"]`
                        : prefix + '[shared a voice note — no transcript available]',
                };
            }
            return { role: 'user', content: prefix + m.content };
        }),
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
                status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const data  = await res.json();
        const reply = data.choices?.[0]?.message?.content || '';

        return new Response(JSON.stringify({ reply, language: detectedLang }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });

    } catch (e) {
        console.error('[GroupChat] Handler error:', e);
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
};
