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
import { WebSocketServer, WebSocket as WsClient } from 'ws';

const PROJECT = process.env.GCP_PROJECT;
const REGION  = process.env.GCP_REGION || 'us-central1';
const SECRET  = process.env.PROXY_SECRET || '';
const PORT    = process.env.PORT || 8080;

// ── Live (speech-to-speech) bridge config ────────────────────────────────────
// Browser <-> this service <-> Vertex Live API. Browsers can't set the
// Authorization header a Vertex WS needs, and Netlify can't hold a socket, so
// this service bridges: it verifies the caller's Supabase session (against
// Supabase's public /auth/v1/user — no JWT secret needed), mints an ADC OAuth
// token (same attached service account — draws the GCP credits), and pipes audio
// frames to/from Vertex. The Google token NEVER reaches the browser.
const SUPABASE_URL      = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const VERTEX_LIVE_MODEL = process.env.VERTEX_LIVE_MODEL || 'gemini-live-2.5-flash';
// Override only if Google moves the service path.
const VERTEX_LIVE_WS_PATH = process.env.VERTEX_LIVE_WS_PATH ||
    'google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent';

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

// ── WebSocket bridge: /live  (Gemini Live, speech-to-speech) ────────────────
// Two upstream modes:
//   • AI Studio (when GEMINI_LIVE_API_KEY is set): browser <-> bridge <-> the
//     generativelanguage Live endpoint, authed with the key (held here, never
//     sent to the browser). This is the only path with native-audio models.
//   • Vertex (default): browser <-> bridge <-> Vertex Live, ADC-authed.
const GEMINI_LIVE_API_KEY = process.env.GEMINI_LIVE_API_KEY || '';
const AISTUDIO = Boolean(GEMINI_LIVE_API_KEY);

function upstreamWsUrl() {
  if (AISTUDIO) {
    return 'wss://generativelanguage.googleapis.com/ws/'
      + 'google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'
      + `?key=${encodeURIComponent(GEMINI_LIVE_API_KEY)}`;
  }
  const host = REGION === 'global' ? 'aiplatform.googleapis.com' : `${REGION}-aiplatform.googleapis.com`;
  return `wss://${host}/ws/${VERTEX_LIVE_WS_PATH}`;
}
const modelResourcePath = () =>
  AISTUDIO
    ? `models/${VERTEX_LIVE_MODEL}`
    : `projects/${PROJECT}/locations/${REGION}/publishers/google/models/${VERTEX_LIVE_MODEL}`;

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has('blak.v1') ? 'blak.v1' : false),
});

// Validate a Supabase access token without any shared secret: ask Supabase who
// it belongs to. 200 → a real, logged-in user; anything else → reject.
async function validateSupabaseToken(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    });
    return r.ok;
  } catch (e) { return false; }
}

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/live')) { socket.destroy(); return; }
  // Auth: the browser passes its Supabase access token as a subprotocol
  // (subprotocols are the only "header" a browser WebSocket can set), so it
  // stays out of the URL and access logs.
  const offered  = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  const jwtProto = offered.find(p => p.startsWith('blak.jwt.'));
  const token    = jwtProto ? jwtProto.slice('blak.jwt.'.length) : '';
  validateSupabaseToken(token).then((ok) => {
    if (!ok) { try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); } catch (e) {} return; }
    wss.handleUpgrade(req, socket, head, (browserWs) => bridgeToVertex(browserWs));
  }).catch(() => { try { socket.destroy(); } catch (e) {} });
});

async function bridgeToVertex(browserWs) {
  let upstream;
  if (AISTUDIO) {
    // AI Studio: the key is in the URL; no per-request token needed.
    upstream = new WsClient(upstreamWsUrl());
  } else {
    let accessToken;
    try {
      authClient = authClient || await auth.getClient();
      const at = await authClient.getAccessToken();
      accessToken = typeof at === 'string' ? at : at?.token;
      if (!accessToken) throw new Error('empty token');
    } catch (e) {
      try { browserWs.close(1011, 'ADC token failed'); } catch {}
      return;
    }
    upstream = new WsClient(upstreamWsUrl(), { headers: { Authorization: `Bearer ${accessToken}` } });
  }
  const queue = [];

  upstream.on('open', () => { for (const m of queue) upstream.send(m); queue.length = 0; });

  // Browser -> Vertex: rewrite setup.model to the full Vertex resource path, so
  // the client sends only a short model name and never learns the project id.
  browserWs.on('message', (data) => {
    let text = data.toString();
    try {
      const obj = JSON.parse(text);
      if (obj && obj.setup) { obj.setup.model = modelResourcePath(); text = JSON.stringify(obj); }
    } catch { /* non-JSON/binary — pass through untouched */ }
    if (upstream.readyState === WsClient.OPEN) upstream.send(text); else queue.push(text);
  });

  // Vertex -> Browser: pass frames straight through.
  upstream.on('message', (data) => {
    if (browserWs.readyState === browserWs.OPEN) browserWs.send(data.toString());
  });

  upstream.on('close', (code, reason) => {
    try { browserWs.close(code >= 1000 && code < 5000 ? code : 1011, String(reason || '').slice(0, 120)); } catch {}
  });
  upstream.on('error', () => { try { browserWs.close(1011, 'vertex upstream error'); } catch {} });
  browserWs.on('close', () => { try { upstream.close(); } catch {} });
  browserWs.on('error', () => { try { upstream.close(); } catch {} });
}

server.listen(PORT, () => console.log(`[vertex-proxy] listening on :${PORT} (HTTP + WS /live; mode=${AISTUDIO ? 'aistudio' : 'vertex'} model=${VERTEX_LIVE_MODEL})`));
