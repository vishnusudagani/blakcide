// Supabase "Send SMS Hook" → delivers the auth OTP over WhatsApp via the Meta
// Cloud API (Blak's own verified number). Supabase generates + verifies the code
// and mints the session; this endpoint only DELIVERS the code. Wire it in the
// Supabase dashboard: Auth → Hooks → "Send SMS hook" = this URL, with the secret.
//
// Required env (Netlify):
//   SEND_SMS_HOOK_SECRET   the hook secret Supabase shows you (format: v1,whsec_…)
//   WHATSAPP_TOKEN         Meta WhatsApp permanent access token
//   WHATSAPP_PHONE_NUMBER_ID   the WhatsApp Business phone-number id
//   WHATSAPP_OTP_TEMPLATE  approved AUTHENTICATION template name (e.g. blaksyd_otp)
//   WHATSAPP_OTP_LANG      template language code (default: en_US)
//   WHATSAPP_OTP_BUTTON    "1" if the template has a copy-code URL button (default 1)
//   WHATSAPP_GRAPH_VERSION default v21.0
import crypto from 'node:crypto';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Standard Webhooks signature check (symmetric HMAC-SHA256) — proves the call is
// really from your Supabase project, not a forger trying to spray WhatsApp OTPs.
function verify(secretRaw, headers, body) {
  if (!secretRaw) return false;
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) return false;
  // replay guard: reject timestamps older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = secretRaw.replace(/^v1,whsec_/, '').replace(/^whsec_/, '');
  const expected = crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
  // header may carry several space-separated "v1,<sig>" pairs
  return sigHeader.split(' ').some((part) => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  const raw = await req.text();
  if (!verify(process.env.SEND_SMS_HOOK_SECRET, req.headers, raw)) {
    return json(401, { error: 'invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return json(400, { error: 'bad json' }); }

  // Supabase send-sms hook shape: { user: { phone }, sms: { otp } }
  const phone = (payload?.user?.phone || '').replace(/^\+/, '');
  const otp = payload?.sms?.otp;
  if (!phone || !otp) return json(400, { error: 'missing phone or otp' });

  const TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE;
  const LANG = process.env.WHATSAPP_OTP_LANG || 'en_US';
  const HAS_BUTTON = (process.env.WHATSAPP_OTP_BUTTON ?? '1') !== '0';
  const GRAPH = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
  if (!TOKEN || !PHONE_ID || !TEMPLATE) return json(500, { error: 'whatsapp env not configured' });

  // AUTHENTICATION templates: body has {{1}} = code; copy-code button repeats it.
  const components = [
    { type: 'body', parameters: [{ type: 'text', text: String(otp) }] },
  ];
  if (HAS_BUTTON) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(otp) }] });
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: { name: TEMPLATE, language: { code: LANG }, components },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 4xx back to Supabase so it surfaces a delivery error to the user
    return json(502, { error: 'whatsapp send failed', detail: detail.slice(0, 300) });
  }
  return json(200, {});
};

export const config = { path: '/api/send-whatsapp-otp' };
