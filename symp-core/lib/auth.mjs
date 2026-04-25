// Supabase JWT verification for the Blaksyd proxy.
//
// Preferred path: local HMAC-SHA256 verification with SUPABASE_JWT_SECRET
// (fast, zero-network, no library). Falls back to calling /auth/v1/user with
// the bearer token if the secret isn't configured — slower but still correct.
//
// Returns { ok:true, user_id } on success or { ok:false, reason } on failure.

import crypto from 'node:crypto';

const SUPABASE_URL        = process.env.SUPABASE_URL        || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY   || '';

function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

function verifyLocal(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed_jwt' };
    const [headerB64, payloadB64, sigB64] = parts;

    // Newer Supabase projects sign JWTs with ES256/RS256 (asymmetric). Local
    // HMAC verification only works for the legacy HS256 algorithm. Bail out
    // early so the caller can fall back to /auth/v1/user instead of always
    // returning bad_signature.
    let header;
    try { header = JSON.parse(b64urlDecode(headerB64).toString('utf8')); }
    catch { return { ok: false, reason: 'malformed_header' }; }
    if (header.alg && header.alg !== 'HS256') {
        return { ok: false, reason: `unsupported_alg:${header.alg}` };
    }

    const signedData   = `${headerB64}.${payloadB64}`;
    const expectedSig  = crypto.createHmac('sha256', SUPABASE_JWT_SECRET).update(signedData).digest();
    const providedSig  = b64urlDecode(sigB64);

    if (expectedSig.length !== providedSig.length ||
        !crypto.timingSafeEqual(expectedSig, providedSig)) {
        return { ok: false, reason: 'bad_signature' };
    }

    let payload;
    try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
    catch { return { ok: false, reason: 'malformed_payload' }; }

    if (payload.exp && payload.exp * 1000 < Date.now()) {
        return { ok: false, reason: 'expired' };
    }
    if (!payload.sub) return { ok: false, reason: 'no_subject' };

    return { ok: true, user_id: payload.sub, payload };
}

async function verifyViaAuthApi(token) {
    if (!SUPABASE_URL) return { ok: false, reason: 'supabase_url_missing' };
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            method:  'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'apikey':        SUPABASE_ANON_KEY || token,
            },
        });
        if (!res.ok) return { ok: false, reason: `auth_api_${res.status}` };
        const user = await res.json();
        if (!user || !user.id) return { ok: false, reason: 'no_user_in_response' };
        return { ok: true, user_id: user.id, payload: user };
    } catch (e) {
        return { ok: false, reason: 'auth_api_error:' + (e.message || 'unknown') };
    }
}

export async function verifySupabaseJwt(token) {
    if (!token) return { ok: false, reason: 'missing_token' };

    // Try local HMAC first if the secret is set — fast and zero-network.
    // If it fails for any reason other than expiry / missing-subject (i.e.
    // bad_signature, unsupported_alg, malformed_header), fall back to the
    // Supabase auth API. This makes the proxy robust to projects that mint
    // ES256/RS256 JWTs as well as legacy HS256-only deployments.
    if (SUPABASE_JWT_SECRET) {
        const local = verifyLocal(token);
        if (local.ok) return local;

        const fatal = local.reason === 'expired'
                   || local.reason === 'no_subject'
                   || local.reason === 'malformed_jwt'
                   || local.reason === 'malformed_payload';
        if (fatal) return local;

        // bad_signature / unsupported_alg / malformed_header → try the API.
        const remote = await verifyViaAuthApi(token);
        if (remote.ok) return remote;
        // Surface the more informative reason for debugging.
        return { ok: false, reason: `local:${local.reason}|remote:${remote.reason}` };
    }

    return await verifyViaAuthApi(token);
}

// Extract the Bearer token from an Authorization header (or null if absent).
export function extractBearer(authHeaderValue) {
    if (!authHeaderValue) return null;
    const m = authHeaderValue.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
}
