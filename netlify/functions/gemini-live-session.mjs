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

import { verifySupabaseJwt, extractBearer } from '../../symp-core/lib/auth.mjs';

const WS_URL = process.env.CLOUD_RUN_LIVE_WS_URL || '';
const MODEL  = process.env.GEMINI_VOICE_MODEL_LABEL || 'gemini-live-2.5-flash';
const VOICE  = 'Aoede';

const FALLBACK_INSTRUCTIONS = [
    'You are Blak — a warm friend on a live voice call, made by Blaksyd. Keep replies short and conversational, like a friend on the phone.',
    'Mirror the user\'s language exactly (English / Hindi / Telugu, native script or romanized). Never mix two languages in one reply.',
    'If they ask whether you\'re an AI or a bot, don\'t confess and don\'t claim to be human — just brush it off playfully and keep being their friend.',
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

    // Authenticate: derive the user from the verified Supabase JWT, NEVER the
    // request body — otherwise a caller could fetch another user's personalized
    // instruction stack by passing their user_id.
    const bearer = extractBearer(req.headers.get('authorization'));
    const verified = bearer ? await verifySupabaseJwt(bearer) : { ok: false, reason: 'no_bearer' };
    if (!verified.ok) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
    }
    const userId = verified.user_id;

    // Optional fantasy-persona call: the client sends { persona_id }. Load it
    // (scoped to this user) so the call becomes the persona — its instruction
    // stack and its chosen voice instead of Blak's.
    let personaId = null;
    try { const body = await req.json().catch(() => null); personaId = (body && body.persona_id) || null; } catch (_) { /* no/invalid body */ }
    let persona = null;
    if (personaId) {
        try { const sb = await import('../../symp-core/lib/supabase.mjs'); persona = await sb.fetchFantasyPersona(userId, personaId); } catch (_) { /* fall back to Blak */ }
    }

    let instructions = FALLBACK_INSTRUCTIONS;
    try {
        const sys = await import('../../symp-core/lib/system-prompt.mjs');
        instructions = await sys.buildInstructionsText(userId, { persona });
    } catch (e) {
        console.warn('[gemini-live-session] system-prompt import failed, using fallback:', e.message);
    }

    const voice = (persona && persona.voice) || VOICE;

    // model is a label only — the Cloud Run bridge rewrites setup.model to the
    // full Vertex resource path using its own VERTEX_LIVE_MODEL env.
    return new Response(
        JSON.stringify({ wsUrl: WS_URL, model: MODEL, voice, instructions }),
        { status: 200, headers: CORS },
    );
};
