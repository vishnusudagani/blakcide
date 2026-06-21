// WhatsApp (Blak) channel — Meta Cloud API + Supabase helpers.
//
// Server-side ONLY. Mirrors two patterns already in this repo:
//   - the service-role REST approach in symp-core/lib/supabase.mjs (no
//     @supabase/supabase-js dependency — keeps Netlify cold starts lean), and
//   - the Cloud API send in netlify/functions/send-whatsapp-otp.mjs.
//
// What it does:
//   - verify the Meta webhook (GET challenge + POST X-Hub-Signature-256)
//   - send a free-form TEXT message inside the 24h customer-service window
//     (free; no template) and download inbound media (voice notes / images)
//   - resolve/auto-create a phone-keyed Blaksyd identity (auth user + minimal
//     profile + wa_identities row + ONE 'whatsapp' channel chat thread)
//   - auto-save the WhatsApp number into the knowledge profile (shared memory)
//   - persist messages to chats/messages, load thread history, dedup by wamid
//
// Env (Netlify): WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_GRAPH_VERSION,
//   WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import crypto from 'node:crypto';
import { upsertKnowledgeFact } from './supabase.mjs';

const SUPABASE_URL              = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GRAPH    = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const TOKEN    = process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const DAY_MS   = 24 * 60 * 60 * 1000;

// ── Supabase service-role REST (local copy of the supabase.mjs sbFetch) ──────
async function sbFetch(path, { method = 'GET', body, prefer } = {}) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('[whatsapp] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    }
    const headers = {
        apikey:         SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
    };
    if (prefer) headers['Prefer'] = prefer;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, status: res.status, data };
}

// ── Webhook verification ─────────────────────────────────────────────────────
export function verifyWebhookGet(reqUrl) {
    const u = new URL(reqUrl);
    const mode      = u.searchParams.get('hub.mode');
    const token     = u.searchParams.get('hub.verify_token');
    const challenge = u.searchParams.get('hub.challenge');
    const expected  = process.env.WHATSAPP_VERIFY_TOKEN || '';
    if (mode === 'subscribe' && expected && token === expected) {
        return { ok: true, challenge: challenge || '' };
    }
    return { ok: false };
}

// X-Hub-Signature-256 = 'sha256=' + HMAC_SHA256(APP_SECRET, rawBody).
// If APP_SECRET isn't set we don't hard-block (so first tests work), but the
// caller logs a warning — SET IT before going public.
export function verifySignature(rawBody, signatureHeader) {
    const secret = process.env.WHATSAPP_APP_SECRET || '';
    if (!secret) return true;
    if (!signatureHeader) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected)); }
    catch (_) { return false; }
}

export function appSecretConfigured() { return !!process.env.WHATSAPP_APP_SECRET; }

// ── Cloud API: send text + download media ────────────────────────────────────
export async function sendText(toPhone, text) {
    if (!TOKEN || !PHONE_ID) throw new Error('[whatsapp] WHATSAPP_TOKEN/PHONE_NUMBER_ID not set');
    const res = await fetch(`https://graph.facebook.com/${GRAPH}/${PHONE_ID}/messages`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            messaging_product: 'whatsapp',
            to:    toPhone,
            type:  'text',
            text:  { body: String(text || '').slice(0, 4096), preview_url: false },
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`[whatsapp] send failed ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
}

// Two hops: GET /{media-id} → { url } ; then GET that url (both need the token).
export async function downloadMedia(mediaId) {
    if (!TOKEN) throw new Error('[whatsapp] WHATSAPP_TOKEN not set');
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH}/${mediaId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!metaRes.ok) throw new Error(`[whatsapp] media meta ${metaRes.status}`);
    const meta = await metaRes.json();
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!binRes.ok) throw new Error(`[whatsapp] media bytes ${binRes.status}`);
    const buffer = Buffer.from(await binRes.arrayBuffer());
    return { buffer, mimeType: meta.mime_type || 'application/octet-stream' };
}

// ── Identity: phone → Blaksyd user (+ minimal profile + wa chat thread) ──────
export async function getOrCreateIdentity(phone, waName) {
    const found = await sbFetch(`wa_identities?phone=eq.${encodeURIComponent(phone)}&select=*`);
    if (found.ok && Array.isArray(found.data) && found.data.length) {
        const row = found.data[0];
        return { userId: row.user_id, chatId: row.chat_id, phone, waName: row.wa_name, identity: row, isNew: false };
    }

    // Phone-keyed auth user → a future WhatsApp-OTP web login maps to the SAME
    // user, giving seamless web↔WhatsApp unification. Never dead-ends: on any
    // failure we fall back to a generated uuid (data still keys off it).
    const userId = await createAuthUser(phone, waName);

    // Minimal profile (only id + username are required) — "auto-add to profile".
    const username = `blak_${String(phone).slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;
    await sbFetch('profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: { id: userId, username, full_name: waName || null },
    }).catch(() => {});

    // The single continuous WhatsApp thread.
    const chatRes = await sbFetch('chats', {
        method: 'POST', prefer: 'return=representation',
        body: { user_id: userId, title: 'WhatsApp', channel: 'whatsapp' },
    });
    const chatId = (chatRes.ok && chatRes.data?.[0]?.id) ? chatRes.data[0].id : null;

    const nowIso = new Date().toISOString();
    const idRes = await sbFetch('wa_identities', {
        method: 'POST', prefer: 'return=representation',
        body: {
            phone, user_id: userId, chat_id: chatId, wa_name: waName || null,
            first_seen_at: nowIso, last_inbound_at: nowIso,
            window_expires_at: new Date(Date.now() + DAY_MS).toISOString(),
        },
    });

    // Auto-save the verified WhatsApp number into the knowledge profile.
    // area/source MUST satisfy the symp_knowledge_facts CHECK constraints:
    //   area ∈ identity|people|world|inner|goals|tastes|other ; source ∈ user|blak.
    await upsertKnowledgeFact({
        userId, area: 'identity', key: 'whatsapp_number', label: 'WhatsApp number',
        value: phone, source: 'blak', confidence: 1.0, evidence: 'Verified via the WhatsApp channel',
    }).catch(() => {});

    return { userId, chatId, phone, waName: waName || null, identity: idRes.ok ? idRes.data?.[0] : null, isNew: true };
}

async function createAuthUser(phone, waName) {
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
            method:  'POST',
            headers: {
                apikey:         SUPABASE_SERVICE_ROLE_KEY,
                Authorization:  `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                phone,                       // E.164 digits, e.g. '919441668899'
                phone_confirm: true,
                user_metadata: { source: 'whatsapp', wa_name: waName || null },
            }),
        });
        if (res.ok) {
            const u = await res.json();
            if (u?.id) return u.id;
        }
    } catch (_) { /* fall through to a synthetic id */ }
    return crypto.randomUUID();
}

// ── Persistence + history ────────────────────────────────────────────────────
export async function persistMessage({ chatId, role, content, mediaType, mediaDescription }) {
    if (!chatId) return;
    await sbFetch('messages', {
        method: 'POST', prefer: 'return=minimal',
        body: {
            chat_id: chatId,
            role,                              // 'user' | 'ai'  (beta convention)
            content: content ?? '',
            media_type: mediaType || null,
            media_description: mediaDescription || null,
        },
    }).catch(() => {});
}

// Recent turns, chronological, mapped to OpenAI roles for /api/symp/v1/chat.
export async function loadThreadHistory(chatId, limit = 16) {
    if (!chatId) return [];
    const r = await sbFetch(`messages?chat_id=eq.${chatId}&order=created_at.desc&limit=${limit}&select=role,content`);
    if (!r.ok || !Array.isArray(r.data)) return [];
    return r.data.reverse()
        .filter((m) => m.content)
        .map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }));
}

// ── 24h window + dedup + consent ─────────────────────────────────────────────
export async function touchInbound(phone) {
    const nowIso = new Date().toISOString();
    await sbFetch(`wa_identities?phone=eq.${encodeURIComponent(phone)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { last_inbound_at: nowIso, window_expires_at: new Date(Date.now() + DAY_MS).toISOString(), updated_at: nowIso },
    }).catch(() => {});
}

export async function touchOutbound(phone) {
    const nowIso = new Date().toISOString();
    await sbFetch(`wa_identities?phone=eq.${encodeURIComponent(phone)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { last_outbound_at: nowIso, updated_at: nowIso },
    }).catch(() => {});
}

// true if this wamid is NEW; false if a duplicate (Meta re-delivers on non-2xx).
export async function isNewEvent(wamid, phone, kind) {
    if (!wamid) return true;
    const r = await sbFetch('wa_events', {
        method: 'POST', prefer: 'return=minimal',
        body: { wamid, phone: phone || null, kind: kind || null },
    });
    return r.ok;                              // 201 → new ; 409 unique-violation → dup
}

export async function markConsentNoted(phone) {
    await sbFetch(`wa_identities?phone=eq.${encodeURIComponent(phone)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { consent_noted_at: new Date().toISOString() },
    }).catch(() => {});
}

// ── Linking: web ↔ WhatsApp (one brain everywhere) ───────────────────────────

// Bind a phone identity to an existing (web) Blaksyd account: repoint the
// wa_identity AND migrate its chat thread + knowledge facts to the web user, so
// both surfaces share one memory. Service-role only.
export async function linkPhoneToUser(phone, webUserId) {
    if (!phone || !webUserId) return { ok: false };
    const found = await sbFetch(`wa_identities?phone=eq.${encodeURIComponent(phone)}&select=*`);
    const row = (found.ok && Array.isArray(found.data) && found.data[0]) ? found.data[0] : null;
    if (!row) return { ok: false };
    const oldUserId = row.user_id;
    const nowIso = new Date().toISOString();

    if (oldUserId !== webUserId) {
        // 1. Move the WhatsApp chat thread(s) to the web account.
        await sbFetch(`chats?user_id=eq.${oldUserId}`, {
            method: 'PATCH', prefer: 'return=minimal', body: { user_id: webUserId },
        }).catch(() => {});
        // 2. Migrate knowledge facts, skipping (area,key) the web user already has (web wins).
        const existing = await sbFetch(`symp_knowledge_facts?user_id=eq.${webUserId}&select=area,key`);
        const have = new Set((existing.ok && Array.isArray(existing.data) ? existing.data : []).map((f) => `${f.area}|${f.key}`));
        const waFacts = await sbFetch(`symp_knowledge_facts?user_id=eq.${oldUserId}&select=id,area,key`);
        if (waFacts.ok && Array.isArray(waFacts.data)) {
            for (const f of waFacts.data) {
                const path = `symp_knowledge_facts?id=eq.${f.id}`;
                if (have.has(`${f.area}|${f.key}`)) {
                    await sbFetch(path, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
                } else {
                    await sbFetch(path, { method: 'PATCH', prefer: 'return=minimal', body: { user_id: webUserId } }).catch(() => {});
                }
            }
        }
    }
    // 3. Repoint the identity.
    await sbFetch(`wa_identities?phone=eq.${encodeURIComponent(phone)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { user_id: webUserId, linked_web: true, updated_at: nowIso },
    }).catch(() => {});
    return { ok: true, merged: oldUserId !== webUserId };
}

// Create a one-time web→WhatsApp link code for a logged-in web user. The web app
// turns it into a wa.me deep link; when the user sends it from WhatsApp, the
// webhook binds that phone to this account.
export async function createLinkCode(webUserId, { ttlMinutes = 30 } = {}) {
    if (!webUserId) return { ok: false };
    const rand = (n) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    const code = 'BLAK-LINK-' + rand(8);
    const r = await sbFetch('wa_link_codes', {
        method: 'POST', prefer: 'return=minimal',
        body: { code, direction: 'web_to_wa', user_id: webUserId, expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString() },
    });
    return r.ok ? { ok: true, code } : { ok: false };
}

// Validate + consume a web→WhatsApp link code sent from `phone`, binding the account.
export async function consumeLinkCode(code, phone) {
    const r = await sbFetch(`wa_link_codes?code=eq.${encodeURIComponent(code)}&direction=eq.web_to_wa&consumed_at=is.null&select=*`);
    const row = (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;
    if (!row) return { ok: false };
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false };
    const link = await linkPhoneToUser(phone, row.user_id);
    if (!link.ok) return { ok: false };
    await sbFetch(`wa_link_codes?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { consumed_at: new Date().toISOString(), phone },
    }).catch(() => {});
    return { ok: true, userId: row.user_id };
}
