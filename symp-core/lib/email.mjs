// Transactional email — the missing notification channel. Provider adapter:
// Resend → Postmark → no-op. Add a key and email "just works"; until then every
// send is a graceful skip (never throws). This is the seam the notify() queue
// uses for the 'email' channel and what Minit callbacks / account mail will use.
//
// Env (set one): RESEND_API_KEY  |  POSTMARK_TOKEN
//   EMAIL_FROM (default 'Blaksyd <noreply@blaksyd.com>')

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || '';
const FROM           = process.env.EMAIL_FROM || 'Blaksyd <noreply@blaksyd.com>';

/** Which email provider (if any) is configured. */
export function emailProvider() {
    if (RESEND_API_KEY) return 'resend';
    if (POSTMARK_TOKEN) return 'postmark';
    return null;
}

export function emailConfigured() {
    return emailProvider() !== null;
}

/**
 * Send a transactional email. Fail-soft: returns {ok:false, skipped:true} when
 * no provider is configured rather than throwing.
 * @param {{to:string, subject:string, html?:string, text?:string, from?:string}} msg
 * @returns {Promise<{ok:boolean, skipped?:boolean, provider?:string, error?:string}>}
 */
export async function sendEmail({ to, subject, html, text, from } = {}) {
    const provider = emailProvider();
    if (!provider) return { ok: false, skipped: true };
    if (!to || !subject) return { ok: false, error: 'to + subject required' };
    const sender = from || FROM;
    try {
        if (provider === 'resend') {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: sender, to: [to], subject, html: html || undefined, text: text || undefined }),
            });
            if (!res.ok) return { ok: false, provider, error: `resend ${res.status}` };
            return { ok: true, provider };
        }
        // postmark
        const res = await fetch('https://api.postmarkapp.com/email', {
            method: 'POST',
            headers: { 'X-Postmark-Server-Token': POSTMARK_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ From: sender, To: to, Subject: subject, HtmlBody: html || undefined, TextBody: text || undefined, MessageStream: 'outbound' }),
        });
        if (!res.ok) return { ok: false, provider, error: `postmark ${res.status}` };
        return { ok: true, provider };
    } catch (e) {
        return { ok: false, provider, error: String(e?.message || e) };
    }
}
