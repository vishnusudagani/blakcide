// POST /api/symp/v1/livekit-token — mint a LiveKit join token for a group room.
//
// The browser calls this (via the symp proxy, which injects the authenticated
// user_id) to join the group's voice call. We verify the caller is a member of
// the room, then mint a short-lived LiveKit access token (a standard HS256 JWT
// signed with LIVEKIT_API_SECRET — no SDK needed) scoped to that room only.
//
// Dormant until LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are set in
// the Netlify env — returns 503 {configured:false} so the client can hide voice.

import { createHmac } from 'node:crypto';
import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

const LIVEKIT_URL    = process.env.LIVEKIT_URL || '';
const LIVEKIT_KEY    = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_SECRET = process.env.LIVEKIT_API_SECRET || '';
const SUPABASE_URL   = process.env.SUPABASE_URL || '';
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const b64url = (s) => Buffer.from(s).toString('base64url');

// Standard LiveKit access token: HS256 JWT, iss=apiKey, video grant scoped to room.
function mintLivekitToken({ identity, name, room, ttlSec = 3600 }) {
    const now = Math.floor(Date.now() / 1000);
    const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
        iss: LIVEKIT_KEY, sub: identity, name, nbf: now - 10, exp: now + ttlSec,
        video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    }));
    const sig = createHmac('sha256', LIVEKIT_SECRET).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
}

async function isMember(roomId, userId) {
    if (!SUPABASE_URL || !SERVICE_KEY) return false;
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/blak_group_members?room_id=eq.${roomId}&user_id=eq.${userId}&select=user_id&limit=1`, {
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        });
        const d = await r.json().catch(() => []);
        return Array.isArray(d) && d.length > 0;
    } catch (e) { return false; }
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const requestId = getRequestId(req);
    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    if (!LIVEKIT_URL || !LIVEKIT_KEY || !LIVEKIT_SECRET) {
        return new Response(JSON.stringify({ ok: false, configured: false, error: { code: 'NOT_CONFIGURED', message: 'LiveKit not configured' } }),
            { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    const { user_id, room_id, display_name } = parsed.data || {};
    if (!user_id || !room_id) return jsonError(ERROR_CODES.BAD_REQUEST, 'user_id and room_id required', 400, requestId);

    if (!(await isMember(room_id, user_id))) {
        return jsonError(ERROR_CODES.FORBIDDEN || 'FORBIDDEN', 'Not a member of this room', 403, requestId);
    }

    const token = mintLivekitToken({
        identity: user_id,
        name: String(display_name || 'Guest').slice(0, 60),
        room: 'bg_' + room_id,   // group voice room name, namespaced
    });

    return new Response(
        JSON.stringify({ ok: true, data: { token, url: LIVEKIT_URL, room: 'bg_' + room_id }, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );
};

export const config = { path: '/api/symp/v1/livekit-token' };
