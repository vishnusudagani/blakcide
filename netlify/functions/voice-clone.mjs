// Persona voice cloning — Netlify Function (the PRODUCTION path on blaksyd.com).
//
//   POST   /api/voice-clone/enroll  — liveness-gated reference clip for ONE language
//   GET    /api/voice-clone/status  — list the user's ready voice clones
//   DELETE /api/voice-clone         — one-tap delete (all languages)
//   POST   /api/voice-clone/speak   — say `text` in the user's cloned voice, gracefully
//                                     falling back to a preset voice if the engine is off
//
// Mirrors symp-backend/src/routes/voice-clone + the /api/tts clone branch, but as a
// serverless function (the site runs on Netlify Functions, not the Express server).
// Self-voice-only: enrollment requires reading a prompt phrase aloud (Whisper liveness).
// Zero-shot: a successful enrollment is immediately 'ready' (the stored clip IS the clone).
// $0: reuses the site's Supabase (Storage + PostgREST) + OpenAI (Whisper + fallback TTS).
// The GPU engine is OPTIONAL — without VOICE_INFER_URL, speak() still talks via a preset
// voice, so the feature never breaks in front of a user; the real cloned voice switches
// on automatically the moment VOICE_INFER_URL is reachable.

import { randomUUID } from 'node:crypto';
import { verifySupabaseJwt, extractBearer } from '../../symp-core/lib/auth.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OPENAI_KEY = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY || '';
const VOICE_INFER_URL = (process.env.VOICE_INFER_URL || '').replace(/\/+$/, '');
const VOICE_INFER_SECRET = process.env.VOICE_INFER_SECRET || '';

const SUPPORTED = ['en', 'hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or', 'as'];
const CONSENT_VERSION = 'voice-clone-v1-2026-06';
const LIVENESS_THRESHOLD = 0.6; // fraction of prompt tokens that must appear in the clip
const MIN_CLIP_BYTES = 8000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ok = (data) => json(200, { ok: true, data });
const fail = (status, code, message) => json(status, { ok: false, error: { code, message } });

// ── helpers ────────────────────────────────────────────────────────────────
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function livenessScore(prompt, spoken) {
  const p = normalize(prompt).split(' ').filter(Boolean);
  if (!p.length) return 0;
  const s = new Set(normalize(spoken).split(' ').filter(Boolean));
  return p.filter((w) => s.has(w)).length / p.length;
}
function extFor(mime) {
  if (!mime) return 'wav';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('webm')) return 'webm';
  return 'wav';
}

async function sbRest(path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
async function storageUpload(objectPath, buffer, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/voice-refs/${objectPath}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buffer,
  });
  return res.ok;
}
async function storageSignedUrl(objectPath, ttl = 120) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/voice-refs/${objectPath}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: ttl }),
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j && j.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : null;
}
async function whisperTranscribe(buffer, contentType, ext, langHint) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  if (langHint && langHint !== 'en') form.append('language', langHint);
  form.append('response_format', 'json');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form,
  });
  if (!r.ok) throw new Error('whisper_' + r.status);
  const j = await r.json();
  return j.text || '';
}
// OpenAI preset fallback — same language/voice matrix as netlify/functions/tts.js.
async function presetTts(text, language) {
  const CFG = { te: { voice: 'shimmer', speed: 0.92 }, hi: { voice: 'nova', speed: 0.95 }, en: { voice: 'nova', speed: 1.0 } };
  const c = CFG[language] || CFG.en;
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: text.slice(0, 500), voice: c.voice, response_format: 'mp3', speed: c.speed }),
  });
  if (!r.ok) throw new Error('preset_tts_' + r.status);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function userFromReq(req) {
  const token = extractBearer(req.headers.get('authorization'));
  if (!token) return null;
  const v = await verifySupabaseJwt(token);
  return v.ok ? v.user_id : null;
}

// ── router ───────────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(500, 'config_error', 'Supabase not configured');

  const path = new URL(req.url).pathname;
  const userId = await userFromReq(req);
  if (!userId) return fail(401, 'unauthorized', 'Sign in to use your Persona voice.');

  try {
    if (req.method === 'POST' && path.endsWith('/enroll')) return await enroll(req, userId);
    if (req.method === 'GET' && path.endsWith('/status')) return await status(userId);
    if (req.method === 'POST' && path.endsWith('/speak')) return await speak(req, userId);
    if (req.method === 'DELETE') return await deleteAll(userId);
    return fail(404, 'not_found', 'Unknown voice-clone route');
  } catch (e) {
    return fail(500, 'internal_error', (e && e.message) || 'unexpected error');
  }
};

export const config = {
  path: ['/api/voice-clone', '/api/voice-clone/enroll', '/api/voice-clone/status', '/api/voice-clone/speak'],
};

// ── handlers ─────────────────────────────────────────────────────────────
async function enroll(req, userId) {
  if (!OPENAI_KEY) return fail(500, 'config_error', 'liveness unavailable (no OpenAI key)');
  let b;
  try { b = await req.json(); } catch { return fail(400, 'bad_request', 'invalid JSON'); }
  const { language, audio_base64, mime_type, prompt_phrase, transcript } = b || {};
  if (!SUPPORTED.includes(language)) return fail(400, 'bad_request', 'unsupported language');
  if (!audio_base64 || !prompt_phrase) return fail(400, 'bad_request', 'audio_base64 and prompt_phrase required');

  const contentType = mime_type || 'audio/wav';
  const ext = extFor(mime_type);
  const buffer = Buffer.from(audio_base64, 'base64');
  if (buffer.byteLength < MIN_CLIP_BYTES) return fail(400, 'clip_too_short', 'recording too short — please read the whole phrase');

  // Liveness: re-transcribe and match the prompted phrase.
  let spoken;
  try { spoken = await whisperTranscribe(buffer, contentType, ext, language); }
  catch { return fail(502, 'liveness_unavailable', 'could not verify the recording, please try again'); }
  const score = livenessScore(prompt_phrase, spoken);
  if (score < LIVENESS_THRESHOLD) return fail(400, 'liveness_failed', 'that did not match the phrase — please read it aloud exactly');

  // Store the reference clip in the PRIVATE bucket (path scoped to the user id).
  const objectPath = `${userId}/${randomUUID()}.${language}.${ext}`;
  if (!(await storageUpload(objectPath, buffer, contentType))) return fail(500, 'storage_error', 'could not save the recording');

  // Consent (append-only).
  const consentRes = await sbRest('symp_voice_consents', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, language, consent_version: CONSENT_VERSION, liveness_passed: true, prompt_phrase, user_agent: req.headers.get('user-agent') || null },
  });
  const consentId = Array.isArray(consentRes.data) && consentRes.data[0] ? consentRes.data[0].id : null;

  // Retire any prior active clone for this language so the unique index allows re-enroll.
  await sbRest(`symp_voice_clones?user_id=eq.${userId}&language=eq.${language}&status=eq.ready&deleted_at=is.null`, {
    method: 'PATCH', body: { status: 'deleted', deleted_at: new Date().toISOString() },
  });

  const cloneRes = await sbRest('symp_voice_clones', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, language, engine: 'omnivoice', ref_clip_path: objectPath, ref_transcript: transcript || spoken, status: 'ready', consent_id: consentId },
  });
  if (!cloneRes.ok || !Array.isArray(cloneRes.data) || !cloneRes.data[0]) return fail(500, 'internal_error', 'could not save the clone');
  const clone = cloneRes.data[0];
  return ok({ clone: { id: clone.id, language: clone.language, status: clone.status }, liveness_score: Number(score.toFixed(2)) });
}

async function status(userId) {
  const r = await sbRest(`symp_voice_clones?user_id=eq.${userId}&deleted_at=is.null&status=neq.deleted&select=id,language,status,created_at&order=created_at.desc`);
  return ok({ clones: Array.isArray(r.data) ? r.data : [] });
}

async function deleteAll(userId) {
  const r = await sbRest(`symp_voice_clones?user_id=eq.${userId}&deleted_at=is.null&select=id`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'deleted', deleted_at: new Date().toISOString() },
  });
  return ok({ deleted: Array.isArray(r.data) ? r.data.length : 0 });
}

async function speak(req, userId) {
  let b;
  try { b = await req.json(); } catch { return fail(400, 'bad_request', 'invalid JSON'); }
  const text = ((b && b.text) || '').trim();
  const language = (b && b.language) || 'en';
  if (!text) return fail(400, 'bad_request', 'text required');

  // Cloned voice — only if there's a ready clone for this language AND an engine is wired.
  if (VOICE_INFER_URL) {
    const r = await sbRest(`symp_voice_clones?user_id=eq.${userId}&language=eq.${language}&status=eq.ready&deleted_at=is.null&select=ref_clip_path,ref_transcript&limit=1`);
    const clone = Array.isArray(r.data) && r.data[0];
    if (clone) {
      const signed = await storageSignedUrl(clone.ref_clip_path, 120);
      if (signed) {
        try {
          const infer = await fetch(`${VOICE_INFER_URL}/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(VOICE_INFER_SECRET ? { 'X-Infer-Secret': VOICE_INFER_SECRET } : {}) },
            body: JSON.stringify({ language, text, mode: 'clone', reference_url: signed, reference_transcript: clone.ref_transcript || undefined, format: 'mp3' }),
          });
          if (infer.ok) {
            const buf = Buffer.from(await infer.arrayBuffer());
            return ok({ audio_base64: buf.toString('base64'), mime_type: infer.headers.get('content-type') || 'audio/mpeg', voice: 'clone:self', language });
          }
        } catch { /* fall through to preset */ }
      }
    }
  }

  // Graceful fallback — preset voice so the persona always speaks (brand-safe).
  if (!OPENAI_KEY) return fail(502, 'voice_unavailable', 'voice service unavailable');
  const audio = await presetTts(text, language);
  return ok({ audio_base64: audio, mime_type: 'audio/mpeg', voice: 'preset', language });
}
