// Blak -> Vertex AI (Gemini) proxy — OpenAI-compatible, ADC-authenticated.
//
// Why this exists: the org security policy DISALLOWS Google API keys, so the
// deployed site can't hold a pasteable Gemini key. This tiny Cloud Run service
// authenticates to Vertex with Application Default Credentials (the attached
// service account — NO keys), and exposes the OpenAI POST /v1/chat/completions
// shape that Blak's existing LLM router already speaks. Point the router's
// GEMINI_BASE_URL at this service; GEMINI_API_KEY is the shared secret below.
//
// Env (set on the Cloud Run service):
//   GCP_PROJECT   (required) — billing-enabled project that holds the credits
//   GCP_REGION    (default us-central1; use "global" for the global endpoint)
//   PROXY_SECRET  (required) — shared secret; callers send it as Bearer / x-proxy-secret
//   PORT          (set by Cloud Run; default 8080)

import http from 'node:http';
import { GoogleAuth } from 'google-auth-library';

const PROJECT = process.env.GCP_PROJECT;
const REGION  = process.env.GCP_REGION || 'us-central1';
const SECRET  = process.env.PROXY_SECRET || '';
const PORT    = process.env.PORT || 8080;

if (!PROJECT) console.warn('[vertex-proxy] GCP_PROJECT is not set — requests will 500.');
if (!SECRET)  console.warn('[vertex-proxy] PROXY_SECRET is not set — proxy is UNAUTHENTICATED.');

// ADC: on Cloud Run this resolves to the attached service account via the
// metadata server (no key files). The library caches + refreshes the token.
const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
let authClient;

function vertexUrl() {
  const host = REGION === 'global' ? 'aiplatform.googleapis.com' : `${REGION}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${PROJECT}/locations/${REGION}/endpoints/openapi/chat/completions`;
}

// Vertex's OpenAI-compatible endpoint expects model ids prefixed "google/".
function normalizeModel(m) {
  if (!m || typeof m !== 'string') return 'google/gemini-2.5-flash';
  return m.includes('/') ? m : `google/${m}`;
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // Health check (Cloud Run / uptime probes).
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    return send(res, 200, { ok: true, service: 'blak-vertex-proxy', project: Boolean(PROJECT), region: REGION });
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    return send(res, 404, { error: { message: 'not found' } });
  }

  // Inbound shared-secret auth (Bearer <secret> or x-proxy-secret: <secret>).
  if (SECRET) {
    const hdr = req.headers['authorization'] || '';
    const presented = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-proxy-secret'] || '');
    if (presented !== SECRET) return send(res, 401, { error: { message: 'unauthorized' } });
  }

  // Read + parse the OpenAI-format body.
  let raw = '';
  try { for await (const chunk of req) raw += chunk; }
  catch { return send(res, 400, { error: { message: 'read error' } }); }
  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch { return send(res, 400, { error: { message: 'invalid JSON' } }); }
  body.model = normalizeModel(body.model);

  // Mint an ADC access token (client cached; token auto-refreshed by the lib).
  let token;
  try {
    authClient = authClient || await auth.getClient();
    const at = await authClient.getAccessToken();
    token = typeof at === 'string' ? at : at?.token;
    if (!token) throw new Error('empty access token');
  } catch (e) {
    return send(res, 500, { error: { message: 'ADC token failed', detail: String(e?.message || e) } });
  }

  // Forward to Vertex (OpenAI-compatible). Stream passthrough when stream:true.
  let upstream;
  try {
    upstream = await fetch(vertexUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return send(res, 502, { error: { message: 'upstream fetch failed', detail: String(e?.message || e) } });
  }

  const ct = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'content-type': ct, 'cache-control': 'no-cache' });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client or upstream closed mid-stream */ }
  }
  res.end();
});

server.listen(PORT, () => console.log(`[vertex-proxy] listening on :${PORT} -> ${vertexUrl()}`));
