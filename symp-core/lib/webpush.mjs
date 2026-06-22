// Web Push sender — VAPID (RFC 8292) signed, PAYLOADLESS pushes. Dep-free
// (node:crypto only). We send no encrypted body: the service worker (public/sw.js)
// shows a warm generic notification and tapping opens Blak, where the actual
// nudge already surfaces. This avoids the RFC 8291 payload-encryption machinery
// (and any npm dep) while still reaching the user's phone.
//
// Keys: VAPID_PRIVATE_PKCS8 (base64 PKCS8 DER of the P-256 private key) +
// VAPID_SUBJECT (mailto:). The matching public key is embedded client-side in
// src/lib/push.mjs as applicationServerKey.

import crypto from 'node:crypto';

const SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:team@blaksyd.com';
const PRIV_PKCS8  = process.env.VAPID_PRIVATE_PKCS8 || '';

function vapidHeaders(endpoint) {
    if (!PRIV_PKCS8) return null;
    let aud;
    try { aud = new URL(endpoint).origin; } catch (_) { return null; }
    const key = crypto.createPrivateKey({ key: Buffer.from(PRIV_PKCS8, 'base64'), format: 'der', type: 'pkcs8' });
    const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    const header  = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`${header}.${payload}`).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { Authorization: `vapid t=${header}.${payload}.${sig}, k=${point}`, TTL: '86400' };
}

export function webPushConfigured() { return !!PRIV_PKCS8; }

// Send one payloadless push. Returns { ok, status }. status 404/410 = the
// subscription is dead and should be pruned by the caller.
export async function sendWebPush(subscription) {
    try {
        if (!subscription || !subscription.endpoint) return { ok: false, status: 0 };
        const headers = vapidHeaders(subscription.endpoint);
        if (!headers) return { ok: false, status: 0, reason: 'no-vapid' };
        const r = await fetch(subscription.endpoint, { method: 'POST', headers });
        return { ok: r.status >= 200 && r.status < 300, status: r.status };
    } catch (e) { return { ok: false, status: 0, reason: String((e && e.message) || e) }; }
}
