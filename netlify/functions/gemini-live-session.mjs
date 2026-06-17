// Gemini Live (speech-to-speech) call — Vertex bridge handshake.
//
// The actual audio socket is the Cloud Run bridge (services/gemini-proxy, path
// /live), which holds the service account and draws the GCP credits — NO Google
// API key, per org policy. This endpoint just hands the browser the bridge URL
// plus the canonical call config (Blak's instruction stack + voice). The browser
// then opens the bridge WS itself, authenticating with its own Supabase access
// token (passed as a WS subprotocol).
//
// If CLOUD_RUN_LIVE_WS_URL is unset, this returns non-200 and the browser falls
// back to the existing OpenAI Realtime call — so calls never break.

const WS_URL = process.env.CLOUD_RUN_LIVE_WS_URL || '';
const MODEL  = process.env.GEMINI_VOICE_MODEL_LABEL || 'gemini-live-2.5-flash';
const VOICE  = 'Aoede';

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
    if (!WS_URL) {
        // Bridge not configured — client falls back to the OpenAI Realtime call.
        return new Response(JSON.stringify({ error: 'CLOUD_RUN_LIVE_WS_URL not configured' }), { status: 501, headers: CORS });
    }

    let userId = null;
    try { const b = await req.json(); userId = b?.user_id || null; } catch (_) { /* body optional */ }

    let instructions = FALLBACK_INSTRUCTIONS;
    try {
        const sys = await import('../../symp-core/lib/system-prompt.mjs');
        instructions = await sys.buildInstructionsText(userId);
    } catch (e) {
        console.warn('[gemini-live-session] system-prompt import failed, using fallback:', e.message);
    }

    // model is a label only — the Cloud Run bridge rewrites setup.model to the
    // full Vertex resource path using its own VERTEX_LIVE_MODEL env.
    return new Response(
        JSON.stringify({ wsUrl: WS_URL, model: MODEL, voice: VOICE, instructions }),
        { status: 200, headers: CORS },
    );
};
