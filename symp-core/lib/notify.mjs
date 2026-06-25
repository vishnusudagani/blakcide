// Unified notification helper — ONE call every pillar can use instead of the
// scattered per-pillar trigger / cron paths that exist today. Writes the in-app
// row (public.notifications) and fans out to the enabled channels (web push,
// email). Each channel is independently gated + fail-soft: a missing provider
// is a skip, never an error, and never blocks the in-app notification.
//
//   await notify({
//     userId, kind: 'minit_free', title, body, url,
//     channels: ['in_app', 'push'],          // default
//     email: { subject, html, text },        // only if 'email' in channels
//   })
//
// Existing paths (minit triggers, blak crons) keep working untouched; new code
// should prefer this single entry point. Channels light up as providers are
// configured — see the capability registry.

import { sendWebPush, webPushConfigured } from './webpush.mjs';
import { pushToUser } from './proactive.mjs';
import { sendEmail, emailConfigured } from './email.mjs';

const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function insertInApp(row) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: {
                'apikey':        SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        'return=minimal',
            },
            body: JSON.stringify(row),
        });
        return res.ok;
    } catch (_) { return false; }
}

/**
 * Send a notification across the requested channels.
 * @param {Object} p
 * @param {string} p.userId
 * @param {string} p.kind                machine kind, e.g. 'minit_free' | 'nexus_reply'
 * @param {string} p.title
 * @param {string} [p.body]
 * @param {string} [p.url]               deep link opened on click
 * @param {object} [p.data]              extra payload stored on the in-app row
 * @param {string[]} [p.channels]        subset of ['in_app','push','email'] (default in_app+push)
 * @param {{subject:string, html?:string, text?:string, to?:string}} [p.email]
 * @returns {Promise<{inApp:boolean, pushed:boolean, emailed:boolean}>}
 */
export async function notify(p = {}) {
    const { userId, kind, title, body = '', url = null, data = null, email = null } = p;
    const channels = Array.isArray(p.channels) ? p.channels : ['in_app', 'push'];
    const out = { inApp: false, pushed: false, emailed: false };
    if (!userId || !kind || !title) return out;

    if (channels.includes('in_app')) {
        out.inApp = await insertInApp({ user_id: userId, kind, title, body, url, data });
    }

    if (channels.includes('push') && webPushConfigured()) {
        try { out.pushed = (await pushToUser(userId, { title, body, url, tag: kind })) > 0; }
        catch (_) { /* fail-soft */ }
    }

    if (channels.includes('email') && email && email.subject && emailConfigured()) {
        // `email.to` must be supplied by the caller (we don't look up addresses here).
        if (email.to) {
            try { const r = await sendEmail(email); out.emailed = !!r.ok; }
            catch (_) { /* fail-soft */ }
        }
    }

    return out;
}

/** Re-exported so callers can branch on availability without extra imports. */
export { webPushConfigured, emailConfigured };
