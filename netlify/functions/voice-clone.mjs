// Persona voice cloning — Netlify Function (the PRODUCTION path on blaksyd.com).
//
//   POST   /api/voice-clone/enroll  — liveness-gated reference clip for ONE language
//   GET    /api/voice-clone/status  — languages ready + per-language clip counts
//   GET    /api/voice-clone/ref     — BEST reference clip (base64) for browser-side cloning
//   DELETE /api/voice-clone         — one-tap delete (all languages: library + clones)
//   POST   /api/voice-clone/speak   — say `text` in the user's cloned voice, gracefully
//                                     falling back to a preset voice if the engine is off
//
// Multi-clip LIBRARY: every enrolled recording is APPENDED to symp_voice_clips
// (never retired), so the more the user speaks the better the reference we can
// pick — and we accumulate a corpus to fine-tune on later. symp_voice_clones
// (one active clip/lang) is kept as a fallback during the transition.
// Self-voice-only: enrollment requires reading a prompt phrase aloud (Whisper
// liveness). $0 core: Supabase (Storage + PostgREST) + Groq (STT) + OpenAI
// (fallback TTS). The GPU clone engine (VOICE_INFER_URL) is OPTIONAL.

import { randomUUID } from 'node:crypto';
import { verifySupabaseJwt, extractBearer } from '../../symp-core/lib/auth.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OPENAI_KEY = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY || '';
// Open-source STT: Groq's free, OpenAI-compatible Whisper (whisper-large-v3).
// Used for liveness verification — no paid OpenAI on the enrollment path.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
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
// The browser sends a 24 kHz mono 16-bit WAV (see toWav24kMono on the page), so we
// can derive clip duration locally — no engine call — to help pick the longest ref.
function wavDurationMs(buffer, ext) {
  if (ext !== 'wav' || buffer.byteLength <= 44) return null;
  return Math.max(0, Math.round((buffer.byteLength - 44) / 48)); // (bytes-44)/(24000*2) * 1000
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
  form.append('model', GROQ_WHISPER_MODEL);
  if (langHint && langHint !== 'en') form.append('language', langHint);
  form.append('response_format', 'json');
  // Open-source STT via Groq's OpenAI-compatible Whisper endpoint (free, no OpenAI).
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form,
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

// Classify a clip's emotion via the engine's wav2vec2 SER. Bounded so it can run as
// a background (waitUntil) task without hanging. Returns null on any failure.
async function classifyEmotion(audioBase64) {
  if (!VOICE_INFER_URL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${VOICE_INFER_URL}/classify-emotion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(VOICE_INFER_SECRET ? { 'X-Infer-Secret': VOICE_INFER_SECRET } : {}) },
      body: JSON.stringify({ audio_base64: audioBase64 }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.emotion) return null;
    return { emotion: j.emotion, confidence: typeof j.confidence === 'number' ? j.confidence : null };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Background: classify a freshly-enrolled clip and write its emotion back. No-op if
// classification fails or returns 'neutral' (the clip's stored default).
async function tagClipEmotion(clipId, audioBase64) {
  const res = await classifyEmotion(audioBase64);
  if (!res || !res.emotion || res.emotion === 'neutral') return;
  await sbRest(`symp_voice_clips?id=eq.${clipId}`, {
    method: 'PATCH',
    body: { emotion: res.emotion, emotion_confidence: res.confidence },
  }).catch(() => null);
}

// Pick the BEST reference clip from the user's growing library (symp_voice_clips).
// Preference: requested language + emotion → requested language → any language
// (OmniVoice clones cross-lingually). Within each, cleanest (SNR) → longest →
// newest wins. Returns null if the user has no library clips yet.
async function pickClip(userId, language, emotion) {
  const SEL = 'select=language,clip_path,transcript,emotion';
  const ORD = 'order=quality_snr_db.desc.nullslast,duration_ms.desc.nullslast,created_at.desc&limit=1';
  const filters = [];
  if (language && emotion) filters.push(`&language=eq.${language}&emotion=eq.${emotion}`);
  if (language) filters.push(`&language=eq.${language}`);
  filters.push(''); // any language
  for (const f of filters) {
    const r = await sbRest(`symp_voice_clips?user_id=eq.${userId}&status=eq.ready&deleted_at=is.null${f}&${SEL}&${ORD}`);
    const row = Array.isArray(r.data) && r.data[0];
    if (row && row.clip_path) return { path: row.clip_path, transcript: row.transcript || '', language: row.language };
  }
  return null;
}

async function userFromReq(req) {
  const token = extractBearer(req.headers.get('authorization'));
  if (!token) return null;
  const v = await verifySupabaseJwt(token);
  return v.ok ? v.user_id : null;
}

// ── router ───────────────────────────────────────────────────────────────
export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(500, 'config_error', 'Supabase not configured');

  const path = new URL(req.url).pathname;
  const userId = await userFromReq(req);
  if (!userId) return fail(401, 'unauthorized', 'Sign in to use your Persona voice.');

  try {
    if (req.method === 'POST' && path.endsWith('/enroll')) return await enroll(req, userId, context);
    if (req.method === 'GET' && path.endsWith('/status')) return await status(userId);
    if (req.method === 'GET' && path.endsWith('/ref')) return await getRef(req, userId);
    if (req.method === 'POST' && path.endsWith('/speak')) return await speak(req, userId);
    if (req.method === 'DELETE') return await deleteAll(userId);
    return fail(404, 'not_found', 'Unknown voice-clone route');
  } catch (e) {
    return fail(500, 'internal_error', (e && e.message) || 'unexpected error');
  }
};

export const config = {
  path: ['/api/voice-clone', '/api/voice-clone/enroll', '/api/voice-clone/status', '/api/voice-clone/ref', '/api/voice-clone/speak'],
};

// ── handlers ─────────────────────────────────────────────────────────────
async function enroll(req, userId, context) {
  if (!GROQ_KEY) return fail(500, 'config_error', 'liveness unavailable (no Groq key)');
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
  // (symp_voice_clones stays single — it's the legacy fallback; the LIBRARY accumulates.)
  await sbRest(`symp_voice_clones?user_id=eq.${userId}&language=eq.${language}&status=eq.ready&deleted_at=is.null`, {
    method: 'PATCH', body: { status: 'deleted', deleted_at: new Date().toISOString() },
  });

  const cloneRes = await sbRest('symp_voice_clones', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, language, engine: 'omnivoice', ref_clip_path: objectPath, ref_transcript: transcript || spoken, status: 'ready', consent_id: consentId },
  });
  if (!cloneRes.ok || !Array.isArray(cloneRes.data) || !cloneRes.data[0]) return fail(500, 'internal_error', 'could not save the clone');
  const clone = cloneRes.data[0];

  // Append to the growing voice LIBRARY (multi-clip). duration_ms lets synth pick
  // the longest/most-content reference. emotion starts 'neutral' and is auto-tagged
  // in the BACKGROUND (waitUntil) so enrollment returns instantly and never blocks
  // on a cold GPU. Best-effort throughout: a hiccup never fails a good enrollment.
  const clipRes = await sbRest('symp_voice_clips', {
    method: 'POST', prefer: 'return=representation',
    body: {
      user_id: userId, language, clip_path: objectPath, transcript: transcript || spoken,
      duration_ms: wavDurationMs(buffer, ext), emotion: 'neutral',
      source: 'enroll', prompt_phrase, liveness_passed: true, consent_id: consentId, status: 'ready',
    },
  }).catch(() => null);
  const clipId = Array.isArray(clipRes?.data) && clipRes.data[0] ? clipRes.data[0].id : null;

  // Auto-tag emotion off the critical path: warm engine → lands in ~1–2s; cold →
  // the background task gives up and the clip stays 'neutral' (re-tagged later).
  // Uses the platform waitUntil; skipped if unavailable (e.g. local dev).
  if (clipId && VOICE_INFER_URL && context && typeof context.waitUntil === 'function') {
    context.waitUntil(tagClipEmotion(clipId, audio_base64));
  }

  return ok({ clone: { id: clone.id, language: clone.language, status: clone.status }, clip_id: clipId, liveness_score: Number(score.toFixed(2)) });
}

async function status(userId) {
  // Reflect the LIBRARY: per-language clip counts, plus a clones-shaped list for
  // backward-compat with the page (it marks a language 'ready' from `clones`).
  const r = await sbRest(`symp_voice_clips?user_id=eq.${userId}&deleted_at=is.null&status=eq.ready&select=language`);
  const rows = Array.isArray(r.data) ? r.data : [];
  const counts = {};
  for (const row of rows) counts[row.language] = (counts[row.language] || 0) + 1;
  const languages = Object.keys(counts);
  if (languages.length === 0) {
    // Pre-backfill / no library yet → fall back to the legacy single clones.
    const lr = await sbRest(`symp_voice_clones?user_id=eq.${userId}&deleted_at=is.null&status=neq.deleted&select=id,language,status,created_at&order=created_at.desc`);
    return ok({ clones: Array.isArray(lr.data) ? lr.data : [], clips: {} });
  }
  return ok({ clones: languages.map((language) => ({ language, status: 'ready' })), clips: counts });
}

// Short-lived signed URL + transcript for the user's BEST reference clip, so the
// browser can pass it to the voice engine as the cloning reference (reference_audio).
async function getRef(req, userId) {
  const url = new URL(req.url);
  const language = url.searchParams.get('language');
  const emotion = url.searchParams.get('emotion'); // optional, forward-looking (emotion-matched ref)

  // Prefer the growing library; fall back to the legacy single clone.
  let chosen = await pickClip(userId, language, emotion);
  if (!chosen) {
    const SEL = 'select=language,ref_clip_path,ref_transcript&order=created_at.desc&limit=1';
    let clone = null;
    if (language) {
      const r1 = await sbRest(`symp_voice_clones?user_id=eq.${userId}&language=eq.${language}&status=eq.ready&deleted_at=is.null&${SEL}`);
      clone = Array.isArray(r1.data) && r1.data[0];
    }
    if (!clone) {
      const r2 = await sbRest(`symp_voice_clones?user_id=eq.${userId}&status=eq.ready&deleted_at=is.null&${SEL}`);
      clone = Array.isArray(r2.data) && r2.data[0];
    }
    if (clone && clone.ref_clip_path) chosen = { path: clone.ref_clip_path, transcript: clone.ref_transcript || '', language: clone.language };
  }
  if (!chosen) return fail(404, 'no_clone', 'No saved voice yet');

  // Download the clip server-side and hand the browser raw base64 — avoids any
  // browser→Supabase cross-origin fetch (which was silently failing → preset voice).
  const signed = await storageSignedUrl(chosen.path, 120);
  if (!signed) return fail(500, 'sign_error', 'Could not sign the reference clip');
  let buf;
  try { const c = await fetch(signed); if (!c.ok) return fail(502, 'clip_fetch', 'clip ' + c.status); buf = Buffer.from(await c.arrayBuffer()); }
  catch (e) { return fail(502, 'clip_fetch', 'could not read the saved clip'); }
  return ok({ audio_base64: buf.toString('base64'), transcript: chosen.transcript || '', language: chosen.language });
}

async function deleteAll(userId) {
  // Soft-delete BOTH the library clips and the legacy clones (one-tap "delete my
  // voice"). A purge job clears the underlying Storage objects.
  const stamp = new Date().toISOString();
  const clips = await sbRest(`symp_voice_clips?user_id=eq.${userId}&deleted_at=is.null&select=id`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'deleted', deleted_at: stamp },
  });
  const clones = await sbRest(`symp_voice_clones?user_id=eq.${userId}&deleted_at=is.null&select=id`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'deleted', deleted_at: stamp },
  });
  const n = (Array.isArray(clips.data) ? clips.data.length : 0) + (Array.isArray(clones.data) ? clones.data.length : 0);
  return ok({ deleted: n });
}

async function speak(req, userId) {
  let b;
  try { b = await req.json(); } catch { return fail(400, 'bad_request', 'invalid JSON'); }
  const text = ((b && b.text) || '').trim();
  const language = (b && b.language) || 'en';
  const emotion = (b && b.emotion) || null;
  if (!text) return fail(400, 'bad_request', 'text required');

  // Cloned voice — only if there's a ready clip for this user AND an engine is wired.
  if (VOICE_INFER_URL) {
    // Prefer the best clip from the library; fall back to the legacy single clone.
    let refPath = null, refTranscript = '';
    const chosen = await pickClip(userId, language, emotion);
    if (chosen) { refPath = chosen.path; refTranscript = chosen.transcript; }
    if (!refPath) {
      const r = await sbRest(`symp_voice_clones?user_id=eq.${userId}&language=eq.${language}&status=eq.ready&deleted_at=is.null&select=ref_clip_path,ref_transcript&limit=1`);
      const clone = Array.isArray(r.data) && r.data[0];
      if (clone) { refPath = clone.ref_clip_path; refTranscript = clone.ref_transcript || ''; }
    }
    if (refPath) {
      const signed = await storageSignedUrl(refPath, 120);
      if (signed) {
        try {
          const infer = await fetch(`${VOICE_INFER_URL}/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(VOICE_INFER_SECRET ? { 'X-Infer-Secret': VOICE_INFER_SECRET } : {}) },
            body: JSON.stringify({ language, text, mode: 'clone', reference_url: signed, reference_transcript: refTranscript || undefined, emotion: emotion || undefined, format: 'mp3' }),
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
