// Mint a short-lived LiveKit access token so the browser can join the call room
// the Blak agent worker is dispatched into. Open-source replacement for the
// OpenAI Realtime ephemeral-key endpoint (realtime-session.js), which can be
// deleted once the LiveKit call path is live.
//
// POST { user_id? } → { url, token, room, identity }
import { AccessToken } from 'livekit-server-sdk';
import { verifySupabaseJwt, extractBearer } from '../../symp-core/lib/auth.mjs';

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export default async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405, headers: CORS });

    // Authenticate: identity comes from the verified JWT, never the body — a
    // billable room token must not be mintable for an arbitrary identity.
    const bearer = extractBearer(req.headers.get('authorization'));
    const verified = bearer ? await verifySupabaseJwt(bearer) : { ok: false };
    if (!verified.ok) return json({ error: 'unauthorized' }, 401);
    const userId = String(verified.user_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'guest';

    const apiKey    = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url       = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
        return json({ error: 'LiveKit not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)' }, 500);
    }

    // One fresh room per call session; the worker is dispatched in to meet the user.
    const room     = `blak-${userId}-${Date.now().toString(36)}`;
    const identity = `user-${userId}`;

    try {
        const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '15m' });
        at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
        const token = await at.toJwt();
        return json({ url, token, room, identity });
    } catch (e) {
        return json({ error: `token mint failed: ${e.message || e}` }, 500);
    }
};

export const config = { path: '/api/livekit-token' };
