// Returns TURN server credentials for WebRTC NAT traversal.
// Supports Metered.ca (set METERED_API_KEY + METERED_APP_NAME in Netlify env)
// or falls back to well-known public STUN servers for development.
//
// WHY a backend function: TURN credentials must never be hardcoded in frontend
// JS. The public OpenRelay credentials are rate-limited and unreliable for
// production cross-network calls (Hyderabad ↔ Rajahmundry scenario).

exports.handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json',
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers: cors, body: '{"error":"Method not allowed"}' };

    // Require a valid Supabase JWT — TURN credentials are billable. (CJS file;
    // the auth helper is ESM, so we dynamic-import it.)
    try {
        const { verifySupabaseJwt, extractBearer } = await import('../../symp-core/lib/auth.mjs');
        const bearer = extractBearer(event.headers.authorization || event.headers.Authorization);
        const v = bearer ? await verifySupabaseJwt(bearer) : { ok: false };
        if (!v.ok) return { statusCode: 401, headers: cors, body: '{"error":"unauthorized"}' };
    } catch (e) {
        return { statusCode: 401, headers: cors, body: '{"error":"unauthorized"}' };
    }

    const meteredKey = process.env.METERED_API_KEY;
    const meteredApp = process.env.METERED_APP_NAME; // e.g. "yourapp" from metered.ca dashboard

    // ── Metered.ca TURN (recommended for production) ──────────────────────
    if (meteredKey && meteredApp) {
        try {
            const res = await fetch(
                `https://${meteredApp}.metered.live/api/v1/turn/credentials?apiKey=${meteredKey}`
            );
            if (res.ok) {
                const iceServers = await res.json();
                return { statusCode: 200, headers: cors, body: JSON.stringify({ iceServers }) };
            }
        } catch (e) {
            console.error('[ice-servers] Metered fetch failed:', e.message);
        }
    }

    // ── Twilio Network Traversal Service (alternative) ────────────────────
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    if (twilioSid && twilioToken) {
        try {
            const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
            const res = await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Tokens.json`,
                { method: 'POST', headers: { Authorization: `Basic ${auth}` } }
            );
            if (res.ok) {
                const data = await res.json();
                return { statusCode: 200, headers: cors, body: JSON.stringify({ iceServers: data.ice_servers }) };
            }
        } catch (e) {
            console.error('[ice-servers] Twilio fetch failed:', e.message);
        }
    }

    // ── Fallback: multiple STUN + static TURN (works for most NAT types) ──
    // These public STUN servers work for ~85% of connections.
    // Symmetric NAT (carrier-grade NAT like Airtel/Jio mobile data) requires
    // real TURN. Set METERED_API_KEY to fix those cases.
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.relay.metered.ca:80' },
        // Public TURN — limited bandwidth, for fallback only
        { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp',username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:80?transport=udp', username: 'openrelayproject', credential: 'openrelayproject' },
    ];

    return { statusCode: 200, headers: cors, body: JSON.stringify({ iceServers }) };
};
