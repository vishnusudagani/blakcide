// Cascaded voice plumbing for Blak calls — proven loop:
//   Sarvam TTS (native Indic voice) ↔ Groq Whisper (multilingual STT) around the
//   gpt-4.1-mini brain. STT is FREE (Groq); TTS is cheap (Sarvam). No Azure audio
//   model (that would torch the credit). Both halves verified for Telugu/Hindi.
//
// Env: GROQ_API_KEY, GROQ_WHISPER_MODEL (default whisper-large-v3),
//      SARVAM_API_KEY, SARVAM_TTS_MODEL (default bulbul:v2), SARVAM_SPEAKER (default anushka).

const env = (k) => process.env[k];

// vibe/lane code (te / romanized-te / hi / en / ta / kn …) → Sarvam BCP-47.
const LANG_TO_SARVAM = {
    te: 'te-IN', hi: 'hi-IN', en: 'en-IN', ta: 'ta-IN', kn: 'kn-IN', ml: 'ml-IN',
    bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN', od: 'od-IN', or: 'od-IN',
};

export function toSarvamLang(lane) {
    if (!lane) return 'en-IN';
    const base = String(lane).toLowerCase().replace('romanized-', '').slice(0, 2);
    return LANG_TO_SARVAM[base] || 'en-IN';
}

/**
 * Detect the language LANE from text by script. Whisper returns native script
 * for Indic speech, so script-detection is reliable for the spoken language.
 * Latin script → 'en' (romanized minor languages fall back to English TTS).
 */
export function detectLane(text) {
    const s = String(text || '');
    if (/[ఀ-౿]/.test(s)) return 'te'; // Telugu
    if (/[ऀ-ॿ]/.test(s)) return 'hi'; // Devanagari (Hindi/Marathi)
    if (/[஀-௿]/.test(s)) return 'ta'; // Tamil
    if (/[ಀ-೿]/.test(s)) return 'kn'; // Kannada
    if (/[ഀ-ൿ]/.test(s)) return 'ml'; // Malayalam
    if (/[ঀ-৿]/.test(s)) return 'bn'; // Bengali
    if (/[઀-૿]/.test(s)) return 'gu'; // Gujarati
    if (/[਀-੿]/.test(s)) return 'pa'; // Gurmukhi (Punjabi)
    if (/[଀-୿]/.test(s)) return 'od'; // Odia
    return 'en';
}

/**
 * Transcribe audio via Groq Whisper (free, multilingual). Returns plain text.
 * @param {Buffer|Uint8Array|ArrayBuffer} audio
 */
export async function transcribe(audio, { mimetype = 'audio/wav', filename = 'audio.wav', language } = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([audio], { type: mimetype }), filename);
    fd.append('model', env('GROQ_WHISPER_MODEL') || 'whisper-large-v3');
    if (language) fd.append('language', language);
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('GROQ_API_KEY')}` },
        body: fd,
    });
    if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    return (j.text || '').trim();
}

/**
 * Synthesize speech via Sarvam (native Indic voices). Long text is chunked on
 * sentence boundaries (Sarvam caps input length). Returns an ARRAY of base64
 * wav chunks; the client plays them in sequence.
 * @param {string} text
 * @param {string} lane   vibe language lane (te / hi / en / …)
 */
export async function synthesize(text, lane, { sampleRate = 22050 } = {}) {
    const target = toSarvamLang(lane);
    const out = [];
    for (const chunk of chunkText(String(text || ''), 480)) {
        const r = await fetch('https://api.sarvam.ai/text-to-speech', {
            method: 'POST',
            headers: { 'api-subscription-key': env('SARVAM_API_KEY'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inputs: [chunk],
                target_language_code: target,
                model:   env('SARVAM_TTS_MODEL') || 'bulbul:v2',
                speaker: env('SARVAM_SPEAKER')   || 'anushka',
                speech_sample_rate: sampleRate,
                enable_preprocessing: true,
            }),
        });
        if (!r.ok) throw new Error(`sarvam ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
        const j = await r.json();
        if (j.audios?.[0]) out.push(j.audios[0]);
    }
    return out;
}

function chunkText(text, max) {
    if (text.length <= max) return [text];
    const out = [];
    let cur = '';
    for (const part of text.split(/(?<=[.!?।])\s+/)) {
        if ((cur + ' ' + part).length > max && cur) { out.push(cur.trim()); cur = part; }
        else cur += (cur ? ' ' : '') + part;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}
