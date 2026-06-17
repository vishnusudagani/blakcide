// Gemini Live (speech-to-speech) call — ephemeral token minter.
//
// Netlify functions can't hold a long-lived WebSocket, so the BROWSER opens the
// Gemini Live WS directly — but with a short-lived ephemeral token, never the
// raw key. This endpoint mints that token and returns the canonical call config
// (model + Blak's instruction stack + voice).
//
// Model: gemini-3.1-flash-live-preview — the cheapest current native-audio Live
// model (~$0.005/min audio in, $0.018/min audio out).
//
// AUTH NOTE: this uses GEMINI_LIVE_API_KEY — a real Google AI Studio key
// (AIza...). It is intentionally NOT the existing GEMINI_API_KEY, which in this
// project is the Vertex-proxy secret used for text chat (see .env.example), not
// a Google key. If GEMINI_LIVE_API_KEY is unset or Google errors, this returns
// a non-200 and the browser falls back to the existing OpenAI Realtime call.

const MODEL = 'gemini-3.1-flash-live-preview';
const VOICE = 'Aoede'; // warm, multilingual prebuilt voice

const FALLBACK_INSTRUCTIONS = [
    'You are Blak — a warm AI friend on a live voice call. Keep replies short and conversational, like a friend on the phone.',
    'Mirror the user\'s language exactly (English / Hindi / Telugu, native script or romanized). Never mix two languages in one reply.',
    'Be honest you are an AI if asked; never pretend to be human.',
].join('\n');

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type':                 'application/json',
};

export default async (req) => {
    if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
    }

    const key = process.env.GEMINI_LIVE_API_KEY;
    if (!key) {
        // Not configured — the client falls back to the OpenAI Realtime call.
        return new Response(JSON.stringify({ error: 'GEMINI_LIVE_API_KEY not configured' }), { status: 501, headers: CORS });
    }

    let userId = null;
    try { const b = await req.json(); userId = b?.user_id || null; } catch (_) { /* body optional */ }

    // Reuse the exact Blak voice instruction stack the OpenAI path uses.
    let instructions = FALLBACK_INSTRUCTIONS;
    try {
        const sys = await import('../../symp-core/lib/system-prompt.mjs');
        instructions = await sys.buildInstructionsText(userId);
    } catch (e) {
        console.warn('[gemini-live-session] system-prompt import failed, using fallback:', e.message);
    }

    const nowMs = Date.now();
    const tokenReq = {
        uses: 1,
        expireTime:           new Date(nowMs + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(nowMs + 2  * 60 * 1000).toISOString(),
        liveConnectConstraints: {
            model:  `models/${MODEL}`,
            config: { responseModalities: ['AUDIO'] },
        },
    };

    try {
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1alpha/auth_tokens:create?key=${encodeURIComponent(key)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tokenReq) },
        );
        if (!r.ok) {
            const err = await r.text();
            console.error('[gemini-live-session] token create failed:', r.status, err);
            return new Response(JSON.stringify({ error: `Gemini token error ${r.status}` }), { status: 502, headers: CORS });
        }
        const data  = await r.json();
        const token = data.name || data.token || null;
        if (!token) {
            return new Response(JSON.stringify({ error: 'No token returned by Gemini' }), { status: 502, headers: CORS });
        }
        return new Response(
            JSON.stringify({ token, model: MODEL, voice: VOICE, instructions }),
            { status: 200, headers: CORS },
        );
    } catch (e) {
        console.error('[gemini-live-session] error:', e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
};
