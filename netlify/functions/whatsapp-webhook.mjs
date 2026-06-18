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
    verifyWebhookGet, verifySignature, appSecretConfigured,
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

    // Hand off to the background worker (returns 202 immediately) then ACK Meta.
    const origin = `https://${req.headers.get('host')}`;
    try {
        await fetch(`${origin}/.netlify/functions/whatsapp-webhook-background`, {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-wa-internal': process.env.SYMP_API_KEY || '' },
            body:    raw,
        });
    } catch (e) {
        console.error('[whatsapp-webhook] background dispatch failed:', e?.message || e);
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
};

export const config = { path: '/api/whatsapp/webhook' };
