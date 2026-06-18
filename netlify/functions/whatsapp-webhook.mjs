// Webhook for the WhatsApp (Blak) channel — Meta Cloud API.
//
//   GET  /api/whatsapp/webhook  → verification handshake (echoes hub.challenge)
//   POST /api/whatsapp/webhook  → inbound messages / status events
//
// POST flow: verify signature → process (capped) → 200.
//   dedup(wamid) → resolve identity (auto-create on first contact) →
//   media → text (reuse /transcribe + /vision) → load thread history →
//   call Blak (/api/symp/v1/chat, stream:false) → persist → send reply.
//
// Blak's personality, knowledge extraction, rolling memory and vibe tracking all
// live INSIDE /api/symp/v1/chat, so WhatsApp Blak behaves exactly like web Blak.
//
// NOTE (v1): processing runs inline within the Netlify function budget. Text turns
// are fast; a media turn (download + transcribe/vision + chat) is heavier. If we
// start brushing the timeout, split the heavy half into a *-background function.

import {
    verifyWebhookGet, verifySignature, appSecretConfigured,
    sendText, downloadMedia, getOrCreateIdentity, persistMessage,
    loadThreadHistory, touchInbound, touchOutbound, isNewEvent, markConsentNoted,
} from '../../symp-core/lib/whatsapp.mjs';

const SYMP_API_KEY = process.env.SYMP_API_KEY || '';
const SYMP_HEADER  = 'x-symp-api-key';

// Subtle, on-brand first-contact note (+ privacy link). Sent once per identity.
const FIRST_TOUCH_NOTE =
    "hey — you're talking to Blak from Blaksyd 🖤 quick note on how I look after your stuff: https://blaksyd.com/privacy";

export default async (req) => {
    // ── GET: Meta verification handshake ──
    if (req.method === 'GET') {
        const v = verifyWebhookGet(req.url);
        return v.ok
            ? new Response(v.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
            : new Response('Forbidden', { status: 403 });
    }
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // ── POST: verify the signature against the RAW body ──
    const raw = await req.text();
    if (!appSecretConfigured()) console.warn('[whatsapp-webhook] WHATSAPP_APP_SECRET not set — signature check skipped. Set it before going public.');
    if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
        return new Response('invalid signature', { status: 401 });
    }

    let payload;
    try { payload = JSON.parse(raw); } catch (_) { return new Response('bad json', { status: 400 }); }

    const origin = `https://${req.headers.get('host')}`;

    // Must finish before returning (serverless freezes after the response). Cap so
    // a slow upstream can't blow the budget; Meta retries on non-2xx and dedup
    // protects against double-processing.
    try {
        await Promise.race([
            handleEvent(payload, origin),
            new Promise((r) => setTimeout(r, 9500)),
        ]);
    } catch (e) {
        console.error('[whatsapp-webhook] handler error:', e?.message || e);
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
};

async function handleEvent(payload, origin) {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const msg   = value?.messages?.[0];
    if (!msg) return;                                   // delivery/read status events → ignore

    const phone  = msg.from;                            // sender's WhatsApp id (digits, no '+')
    const wamid  = msg.id;
    const kind   = msg.type;
    const waName = value?.contacts?.[0]?.profile?.name || null;

    if (!(await isNewEvent(wamid, phone, kind))) return; // idempotency

    const id = await getOrCreateIdentity(phone, waName);
    await touchInbound(phone);

    const userText = await extractText(msg, kind, id.userId, origin);
    if (!userText) {
        await sendText(phone, "i can do text, voice notes and pics for now — send me one of those 🙂");
        await touchOutbound(phone);
        return;
    }

    // Persist the user's turn (media flagged for the synced web sidebar).
    await persistMessage({
        chatId: id.chatId, role: 'user', content: userText,
        mediaType: kind !== 'text' ? kind : null,
    });

    // messages = recent thread (already includes this turn) → Blak.
    const history  = await loadThreadHistory(id.chatId, 16);
    const messages = history.length ? history : [{ role: 'user', content: userText }];

    let reply = '';
    try { reply = await callBlak(origin, id.userId, messages); }
    catch (e) { console.error('[whatsapp-webhook] blak call failed:', e?.message || e); }
    if (!reply) reply = "got you — give me a sec, say that again? 🙂";

    // First-contact note: prepend once.
    const consentNoted = !!id.identity?.consent_noted_at;
    const outbound = !consentNoted ? `${FIRST_TOUCH_NOTE}\n\n${reply}` : reply;
    if (!consentNoted) await markConsentNoted(phone);

    await persistMessage({ chatId: id.chatId, role: 'ai', content: reply });
    await sendText(phone, outbound);
    await touchOutbound(phone);
}

// text | audio (voice note) | image → plain text Blak can read.
async function extractText(msg, kind, userId, origin) {
    if (kind === 'text') return msg.text?.body?.trim() || '';

    if (kind === 'audio' || kind === 'voice') {
        const mediaId = msg.audio?.id || msg.voice?.id;
        if (!mediaId) return '';
        try {
            const { buffer, mimeType } = await downloadMedia(mediaId);
            const out = await callJson(origin, '/api/symp/v1/transcribe', {
                user_id: userId, audioBase64: buffer.toString('base64'), mimeType,
            });
            return (out?.data?.text || '').trim();
        } catch (e) { console.error('[wa] transcribe failed:', e?.message || e); return ''; }
    }

    if (kind === 'image') {
        const mediaId = msg.image?.id;
        const caption = msg.image?.caption?.trim() || '';
        if (!mediaId) return caption;
        try {
            const { buffer, mimeType } = await downloadMedia(mediaId);
            const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
            const out = await callJson(origin, '/api/symp/v1/vision', { user_id: userId, imageUrl: dataUrl });
            const desc = out?.data?.description || 'an image';
            return caption ? `${caption}\n\n[shared a photo: ${desc}]` : `[shared a photo: ${desc}]`;
        } catch (e) { console.error('[wa] vision failed:', e?.message || e); return caption || ''; }
    }

    return '';                                          // sticker / location / contact / etc.
}

async function callBlak(origin, userId, messages) {
    const out = await callJson(origin, '/api/symp/v1/chat', { user_id: userId, messages, stream: false });
    return (out?.data?.reply || '').trim();
}

async function callJson(origin, path, body) {
    const res = await fetch(`${origin}${path}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', [SYMP_HEADER]: SYMP_API_KEY },
        body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return res.json();
}

export const config = { path: '/api/whatsapp/webhook' };
