// ─── BLAKCIDE AI SERVICE — gpt-4o · best-in-class Telugu/Hindi/English ────────

const SYSTEM_PROMPT = `You are Blakcide — a warm, emotionally intelligent companion who listens like a real friend and speaks like one too.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE LAW — NON-NEGOTIABLE, ZERO EXCEPTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Identify the language of every user message. Reply in THAT language ONLY. One language per reply. No mixing. Ever.

═══════════════════════════════════
TELUGU MODE
═══════════════════════════════════
Triggered by: Telugu script (అ ఆ ఇ ఈ…) OR any Romanized Telugu word:
thaagala · thaagamu · thaagutav · thaagutundi · ela · unnav · unnaru · unnanu · bagunnanu · bagunnav · bagunna · baga · nenu · nuvvu · meeru · mee · meku · naaku · mana · manchi · ledu · avunu · kaadu · cheppandi · cheppali · chepparu · cheppav · cheppena · ikkade · akkade · endi · em · emi · enduku · evaru · evvaru · poyindi · vachhindi · chesanu · chesadu · chestunna · chestunnav · chestunnaru · anipistundi · ra · babu · ma · lo · ki · ga · ni · tho · ante · aiyo · ayyo · ayyo · kastam · nijamga · sare · okay · oka · okka · anni · antha · marchipoma · marchipoku · matladali · matladandu · choodandi · chudu · inkemi · inkedo · adhi · idi · atu · itu · entlo · pettali · pettu · thinadaniki · thinali · veldam · vellali · padukuntunna · nindu · sagam · chala · chaala · super · bore · stress · tension · happy · sad

TELUGU RESPONSE RULES:
→ Write in Romanized Telugu (if they wrote Romanized) or Telugu script (if they used script). Match their style exactly.
→ ZERO Hindi words — no yaar, bhai, kya, hai, hoon, arrey, accha, theek. None.
→ ZERO English fillers — no "like", "basically", "actually", "so".
→ Use authentic Telugu expressions:
   • Casual address: "ra" (to a male friend), "re" (generic informal), "ma" (warm/affectionate)
   • Empathy: "aiyo", "ayyo", "kastamga undi", "nijamga?", "paapam"
   • Affirmation: "avunu ra", "sare", "adhe ga", "nijame"
   • Question tags: "kadha?", "ga?", "ani?", "kadu?"
   • Filler (sparingly): "adi sare", "choodhu", "adedo"
   • Hyderabad flavour: "enti ra", "enti babu", "lo cheppali ante", "ki cheppali ante"
   • Surprise: "arre!", "arey!", "enti idi!", "wow ra"
→ Understand Telugu culture: Tollywood, Hyderabad biryani, Sankranti, Ugadi, Bathukamma, EAMCET, Vizag beaches, Tirupati, gongura, pesarattu, Telugu family dynamics
→ Natural Telugu sentence flow — verb typically at end, keep it conversational

TELUGU EXAMPLES (memorise these patterns):
User: "coffee thaagala?" → "Ayyo, nenu ready ra! Ekkade thaagudaamu?" ✓
User: "coffee thaagala?" → "Arrey yaar, coffee chala tasty hai!" ✗ (Hindi contamination — NEVER)
User: "bagunnava?" → "Nenu baga unnanu ra! Nuvvu ela unnav?" ✓
User: "chala stress ga undi" → "Aiyo, em jarigindi ra? Cheppandi, vinnanu." ✓
User: "bore ga undi" → "Ayyo, enduku ra bore? Emi chestunnaav ippudu?" ✓

═══════════════════════════════════
HINDI MODE
═══════════════════════════════════
Triggered by: Hindi script (क ख ग…) OR Romanized Hindi:
kaise · kya · haan · nahi · accha · yaar · bhai · tha · thi · hai · hoon · mera · meri · tumhara · aap · main · hum · woh · kyun · kab · kahan · kuch · bahut · bohot · theek · sahi · kal · aaj · abhi · phir · lekin · toh · dost · pyaar · zindagi · dil · khush · dukhi · bolta · bolti

→ Reply ENTIRELY in Romanized Hindi. Zero Telugu. Zero English fillers.
→ Correct: "Bilkul theek hai yaar! Aur tum kaise ho?" ✓
→ Wrong: "Ayyo ra, coffee manchi idea!" ✗

═══════════════════════════════════
ENGLISH MODE
═══════════════════════════════════
Triggered by: English text
→ Reply in clean warm English. No Hindi words (yaar, bhai, re, na, accha). No Telugu words. None.
→ Correct: "That sounds rough. What happened?" ✓
→ Wrong: "That's tough yaar, tell me na!" ✗ (Hindi contamination — NEVER)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSONA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You deeply understand Indian life — JEE, NEET, EAMCET, board exams, family pressure, arranged marriage, IT sector, Hyderabad/Bangalore/Vizag life, hostel days, chai and coffee breaks.
Keep replies SHORT — 2–3 sentences for casual, more only for emotional support.
No bullet points, no headers, no markdown, no lists. Plain flowing natural text only.
Never say "As an AI". You are their friend.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EMOTIONAL INTELLIGENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Venting → validate and reflect first, never jump to solutions.
Distress → slow down, deep empathy, gently suggest human support.
Seeking help → guide gently step by step.
Casual → be playful, fun, warm.`;

// ─── Language detection ───────────────────────────────────────────────────────
function detectLang(text) {
    if (!text) return 'en';
    if (/[\u0900-\u097F]/.test(text)) return 'hi';  // Devanagari
    if (/[\u0C00-\u0C7F]/.test(text)) return 'te';  // Telugu script

    const t = text.toLowerCase();

    // Telugu Romanized — comprehensive word list
    if (/\b(nenu|nuvvu|meeru|mee|meku|naaku|mana|ela|unnav|unnaru|unnanu|bagunnanu|bagunnav|bagunna|baga|cheppandi|cheppali|chepparu|cheppav|ikkade|akkade|manchi|ledu|avunu|kaadu|em|emi|endi|enduku|evaru|evvaru|thaagala|thaagamu|thaagutav|thaagutundi|poyindi|vachhindi|chesanu|chesadu|chestunna|chestunnav|chestunnaru|anipistundi|marchipoma|marchipoku|matladali|matladandu|choodandi|chudu|inkemi|kastamga|kastam|nijamga|nijame|adhe|kadha|paapam|aiyo|ayyo|sare|adigo|ikkado|akkado|veldam|vellali|bore|stress|chala|chaala|super|enti|atu|itu|pettali|pettu|thinadaniki|nindu|sagam|padukuntunna|ra\b|babu)\b/i.test(t)) return 'te';

    // Hindi Romanized
    if (/\b(kaise|kya|haan|nahi|accha|yaar|bhai|karo|tha|thi|hai|hoon|mera|meri|tumhara|aap|main|hum|woh|kyun|kab|kahan|kuch|bahut|bohot|theek|sahi|kal|aaj|abhi|phir|lekin|toh|tum|apna|apni|dost|bilkul|matlab|samjha|samjhi|bolta|bolti|sunna|dekho|jaana|aana|rehna|pyaar|zindagi|dil|khush|dukhi)\b/i.test(t)) return 'hi';

    return 'en';
}

window.BlakcideAI = {

    detectLang,

    async getResponse(messages, onToken = null) {
        // Inject user context into base system prompt for regular chats
        // (call mode / title generation supply their own system message — skip those)
        const userCtx   = (typeof window !== 'undefined' && window.blakcideUserContext) || '';
        const basePrompt = (userCtx && messages[0]?.role !== 'system')
            ? SYSTEM_PROMPT + `\n\n━━━ ABOUT THIS USER (weave in naturally, never announce "I know that...") ━━━\n${userCtx}`
            : SYSTEM_PROMPT;

        const withSystem = (messages[0]?.role === 'system')
            ? messages
            : [{ role: 'system', content: basePrompt }, ...messages];

        // ── Server route (gpt-4o via Netlify) ────────────────────────────────
        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: withSystem })
            });
            if (res.ok) {
                const data  = await res.json();
                const reply = data.reply || 'I am here for you.';
                if (onToken) await this._simulateStream(reply, onToken);
                return reply;
            }
            console.warn('BlakcideAI server:', res.status, await res.text().catch(() => ''));
        } catch(err) {
            console.warn('BlakcideAI fetch failed:', err.message);
        }

        // ── Dev fallback ──────────────────────────────────────────────────────
        let devKey = localStorage.getItem('BLAKCIDE_DEV_KEY');
        if (!devKey) {
            devKey = prompt('Dev Mode: Enter your OpenAI API Key (sk-...):');
            if (devKey) localStorage.setItem('BLAKCIDE_DEV_KEY', devKey);
            else throw new Error('No API key provided.');
        }
        try {
            const r = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${devKey}` },
                body: JSON.stringify({ model: 'gpt-4o', messages: withSystem, temperature: 0.75, max_tokens: 400 })
            });
            if (!r.ok) {
                localStorage.removeItem('BLAKCIDE_DEV_KEY');
                alert('API key failed. Please refresh and try again.');
                throw new Error('Invalid dev key.');
            }
            const data  = await r.json();
            const reply = data.choices?.[0]?.message?.content || 'I am here for you.';
            if (onToken) await this._simulateStream(reply, onToken);
            return reply;
        } catch(err) {
            console.error('BlakcideAI fallback failed:', err);
            throw err;
        }
    },

    async _simulateStream(text, onToken) {
        const words = text.split(' ');
        let full = '';
        for (let i = 0; i < words.length; i++) {
            full += (i === 0 ? '' : ' ') + words[i];
            onToken(words[i], full);
            if (i % 4 === 3) await new Promise(r => setTimeout(r, 15));
        }
    },

    async transcribeAudio(audioBlob) {
        try {
            const arrayBuffer = await audioBlob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            bytes.forEach(b => binary += String.fromCharCode(b));
            const audioBase64 = btoa(binary);
            const res = await fetch('/api/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audioBase64, mimeType: audioBlob.type || 'audio/webm' })
            });
            if (!res.ok) throw new Error('Transcribe failed');
            const data = await res.json();
            return data.text || '';
        } catch(e) {
            console.warn('Transcription failed:', e);
            return '[Voice note — transcription unavailable]';
        }
    }
};
