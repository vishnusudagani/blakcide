// Web Push sender — VAPID (RFC 8292) auth + RFC 8291/8188 (aes128gcm) payload
// encryption. Dep-free: node:crypto only.
//
// sendWebPush(subscription, payload?):
//   - With a payload AND the subscription's p256dh+auth keys, the JSON payload is
//     encrypted (aes128gcm) so the notification shows its real title/body. The
//     service worker (public/sw.js) reads event.data.json().
//   - Without a payload (or keys), an empty payloadless push is sent and the SW
//     falls back to a warm generic line.
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
    return { Authorization: `vapid t=${header}.${payload}.${sig}, k=${point}` };
}

function hkdf(salt, ikm, info, len) {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

// RFC 8291 (Message Encryption for Web Push) over RFC 8188 aes128gcm.
// Returns the encrypted body Buffer (header || ciphertext). Throws on bad keys.
export function encryptPayload(p256dhB64, authB64, plaintext) {
    const uaPublic = Buffer.from(p256dhB64, 'base64url');     // 65-byte client public point
    const authSecret = Buffer.from(authB64, 'base64url');     // 16-byte client auth secret
    if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');

    const ecdh = crypto.createECDH('prime256v1');
    const asPublic = ecdh.generateKeys();                     // server ephemeral public (65 bytes)
    const ecdhSecret = ecdh.computeSecret(uaPublic);          // shared secret (32 bytes)

    // Combine step (RFC 8291 §3.4): derive the IKM for the content encryption.
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info'), Buffer.from([0]), uaPublic, asPublic]);
    const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

    // Content encryption keys (RFC 8188 §2.2) bound to a per-message salt.
    const salt = crypto.randomBytes(16);
    const cek   = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])]), 16);
    const nonce = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])]), 12);

    // Single record: plaintext || 0x02 (last-record padding delimiter), AES-128-GCM.
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
    const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

    // aes128gcm content-coding header: salt(16) | rs(4) | idlen(1) | keyid(=asPublic).
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
    const head = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
    return Buffer.concat([head, ciphertext]);
}

export function webPushConfigured() { return !!PRIV_PKCS8; }

// Send one push. payload (optional) = { title, body, url, tag }. Returns
// { ok, status }; status 404/410 = the subscription is dead, prune it.
export async function sendWebPush(subscription, payload) {
    try {
        if (!subscription || !subscription.endpoint) return { ok: false, status: 0 };
        const vh = vapidHeaders(subscription.endpoint);
        if (!vh) return { ok: false, status: 0, reason: 'no-vapid' };
        const headers = { ...vh, TTL: '86400' };
        let body;
        if (payload && subscription.p256dh && subscription.auth) {
            try {
                body = encryptPayload(subscription.p256dh, subscription.auth, JSON.stringify(payload));
                headers['Content-Encoding'] = 'aes128gcm';
                headers['Content-Type'] = 'application/octet-stream';
            } catch (_) { body = undefined; }    // fall back to payloadless on key trouble
        }
        const r = await fetch(subscription.endpoint, { method: 'POST', headers, body });
        return { ok: r.status >= 200 && r.status < 300, status: r.status };
    } catch (e) { return { ok: false, status: 0, reason: String((e && e.message) || e) }; }
}
