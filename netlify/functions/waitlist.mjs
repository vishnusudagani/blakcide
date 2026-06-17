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

// Best-effort in-memory rate limit: max RL_MAX submits per RL_WINDOW_MS per IP,
// scoped to a warm function instance (resets on cold start) — marginal but free.
// For hard guarantees pair with Turnstile / Netlify Blobs. Never throws.
const RL_MAX = 6;
const RL_WINDOW_MS = 60_000;
const rlHits = new Map();
function rateOk(ip) {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  rlHits.set(ip, arr);
  if (rlHits.size > 5000) {
    for (const [k, v] of rlHits) { if (!v.length || now - v[v.length - 1] > RL_WINDOW_MS) rlHits.delete(k); }
  }
  return arr.length <= RL_MAX;
}

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
  let hp = '';
  try {
    const body = await req.json();
    email = String(body?.email || '').trim().toLowerCase();
    hp = String(body?.website ?? body?.hp ?? '').trim();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  // Honeypot: a hidden field humans never fill. If it's set, treat as a bot —
  // return the success shape (so it learns nothing) but store nothing.
  if (hp) return json({ ok: true }, 200);

  if (!EMAIL_RE.test(email) || email.length > 320) {
    return json({ ok: false, error: 'Enter a valid email.' }, 400);
  }

  // Best-effort per-IP throttle (defense in depth; the generous cap never blocks a
  // normal human). Must never break the form, so any failure just allows through.
  try {
    const ip = req.headers.get('x-nf-client-connection-ip')
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (ip && !rateOk(ip)) {
      return json({ ok: false, error: 'Too many requests — please try again in a minute.' }, 429);
    }
  } catch { /* limiter must never break the form */ }

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
