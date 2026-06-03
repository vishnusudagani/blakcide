// Waitlist capture — the landing "Begin" modal POSTs an email here; we store it
// in public.signups (Supabase) SERVER-SIDE with the service-role key. RLS denies
// anon/authenticated on that table, so the public anon key can neither read nor
// write it — only this function (service-role) can. Idempotent via the unique
// index on signups(email): a duplicate email is ignored, not an error.
const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json({ ok: false, error: 'Method not allowed' }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'Waitlist not configured' }, 500);
  }

  let email = '';
  try {
    const body = await req.json();
    email = String(body?.email || '').trim().toLowerCase();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!EMAIL_RE.test(email) || email.length > 320) {
    return json({ ok: false, error: 'Enter a valid email.' }, 400);
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/signups?on_conflict=email`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ ok: false, error: 'Could not save right now. Please try again.', detail: detail.slice(0, 200) }, 502);
    }
    return json({ ok: true }, 200);
  } catch {
    return json({ ok: false, error: 'Network error saving signup.' }, 502);
  }
};
