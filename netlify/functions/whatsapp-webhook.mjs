// Webhook for the WhatsApp (Blak) channel — Meta Cloud API. SYNC DISPATCHER.
//
//   GET  /api/whatsapp/webhook  → verification handshake (echoes hub.challenge)
//   POST /api/whatsapp/webhook  → verify signature, hand off to the background
//                                  worker, and ACK 200 immediately.
//
// The real processing (identity, media, the in-process Blak brain, persistence,
// send) lives in whatsapp-webhook-background.mjs — a Netlify *background* function
// with a 15-minute budget — so a slow model can never trip the ~10s sync-function
// timeout (which previously cut replies off and forced the canned fallback).

import {
    verifyWebhookGet, verifySignature, appSecretConfigured, captureDebug,
} from '../../symp-core/lib/whatsapp.mjs';

export default async (req) => {
    // ── GET: Meta verification handshake ──
    if (req.method === 'GET') {
        const v = verifyWebhookGet(req.url);
        return v.ok
            ? new Response(v.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
            : new Response('Forbidden', { status: 403 });
    }
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // ── POST: verify signature against the RAW body ──
    const raw = await req.text();
    if (!appSecretConfigured()) {
        console.warn('[whatsapp-webhook] WHATSAPP_APP_SECRET not set — signature check skipped. Set it before going public.');
    }
    if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
        return new Response('invalid signature', { status: 401 });
    }

    // TEMP debug: log EVERY inbound webhook (any shape) so we can see exactly what
    // coexistence delivers. Remove once the real number is confirmed.
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { /* non-json */ }
    captureDebug(parsed, `field=${parsed?.entry?.[0]?.changes?.[0]?.field || '?'}`);

    // Route by webhook field: 'calls' → the voice call bridge (Pipecat/Cloud Run,
    // if WHATSAPP_CALL_BRIDGE_URL is set); everything else ('messages', etc.) → the
    // background chat worker. One Meta callback URL serves both.
    const field = parsed?.entry?.[0]?.changes?.[0]?.field || 'messages';

    const bridge = process.env.WHATSAPP_CALL_BRIDGE_URL;
    const target = (field === 'calls' && bridge)
        ? `${bridge.replace(/\/+$/, '')}/whatsapp`
        : `https://${req.headers.get('host')}/.netlify/functions/whatsapp-webhook-background`;

    try {
        await fetch(target, {
            method:  'POST',
            headers: {
                'content-type':       'application/json',
                'x-hub-signature-256': req.headers.get('x-hub-signature-256') || '', // let the bridge re-verify
                'x-wa-internal':      process.env.SYMP_API_KEY || '',
            },
            body: raw,
        });
    } catch (e) {
        console.error('[whatsapp-webhook] dispatch failed:', e?.message || e);
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
};

export const config = { path: '/api/whatsapp/webhook' };
