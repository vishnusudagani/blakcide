// POST /api/symp/v1/voice — one turn of a cascaded voice call.
//
//   audio (base64) → Groq Whisper STT (free, multilingual)
//                  → Blak brain (gpt-4.1-mini, full Vault context, quality tier)
//                  → Sarvam TTS (native Indic voice)
//
// Feeds the SAME vibe + rolling-memory pipeline as /chat, so calls and chats
// share one evolving profile (true cross-context). Turn-based v1 (runs on
// Netlify, ~3s/turn); LiveKit full-duplex is the v2 upgrade.
//
// Request:  { user_id, audio?: <base64>, mimetype?, text?, lane? }
// Response: { ok, data: { transcript, reply, lane, audio: [<base64 wav>...] } }

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { buildChatSystemStack } from '../../symp-core/lib/system-prompt.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';
import { transcribe, synthesize, detectLane } from '../../symp-core/lib/voice.mjs';
import { recordEventAsync } from '../../symp-core/lib/vibe-tracker.mjs';
import { updateRollingMemoryAsync } from '../../symp-core/lib/memory-updater.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

const CALL_FRAMING = {
    role: 'system',
    content: 'You are on a live VOICE call with the user. Reply in 1–2 short, natural spoken sentences — warm, like a close friend on the phone. NO markdown, NO bullet lists, NO emoji, no stage directions. Always in the user\'s current language.',
};

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const { user_id, audio, mimetype, text, lane: clientLane } = parsed.data || {};
    if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);

    // ── 1. Speech → text (Groq Whisper) ──────────────────────────────────
    // Pin the STT language from the caller's known lane when provided — Whisper's
    // auto-detect confuses acoustically-similar Indian languages (e.g. Telugu↔
    // Kannada), and a wrong detection cascades into a wrong-language reply.
    const isoHint = (l) => { const b = String(l || '').replace('romanized-', '').slice(0, 2); return b === 'od' ? 'or' : (b || undefined); };
    let transcript = (text || '').trim();
    if (!transcript && audio) {
        try {
            const buf = Buffer.from(audio, 'base64');
            transcript = await transcribe(buf, { mimetype: mimetype || 'audio/webm', filename: 'turn.webm', language: isoHint(clientLane) });
        } catch (e) {
            return jsonError(ERROR_CODES.UPSTREAM_FAILED, `STT failed: ${e.message || e}`, 502, requestId);
        }
    }
    if (!transcript) return jsonError(ERROR_CODES.BAD_REQUEST, 'audio or text is required', 400, requestId);

    // Auto-detect the spoken language from the transcript (so the user can switch
    // freely mid-call); a non-'auto' clientLane acts as an explicit override.
    const lane = (clientLane && clientLane !== 'auto') ? clientLane : detectLane(transcript);
    const LANG = { en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', od: 'Odia' };
    const langName = LANG[String(lane).replace('romanized-', '').slice(0, 2)] || "the user's language";

    // ── 2. Brain (gpt-4.1-mini, full Vault context; quality tier = Azure) ─
    let systemStack = [];
    try { systemStack = await buildChatSystemStack(user_id); } catch (_) { /* soft */ }
    // Force the reply language to match what the user JUST spoke — overrides any
    // vibe/vault language bias (fixes "spoke English, got a Hindi reply").
    const replyLang = { role: 'system', content: `The user just spoke in ${langName}. Reply ONLY in ${langName}; do NOT switch to any other language.` };
    const messages = [...systemStack, CALL_FRAMING, replyLang, { role: 'user', content: transcript }];

    let reply = '';
    try {
        const out = await chatCompleteFailover(messages, { tier: 'quality', maxTokens: 160, temperature: 0.7, timeoutMs: 20000 });
        reply = (out.text || '').trim();
    } catch (e) {
        return jsonError(ERROR_CODES.UPSTREAM_FAILED, `LLM failed: ${e.message || e}`, 502, requestId);
    }
    if (!reply) reply = "Mmm, I didn't quite catch that — say it once more?";

    // ── 3. Text → speech (Sarvam, native Indic) ──────────────────────────
    let audioChunks = [];
    try { audioChunks = await synthesize(reply, lane); } catch (_) { /* audio optional → client shows text */ }

    // ── 4. Feed the shared brain (vibe + rolling memory) — same as /chat ──
    recordEventAsync(user_id, { source: 'ai_call', evidence: `User: ${transcript}\n\nAssistant: ${reply}` });
    updateRollingMemoryAsync(user_id, { userText: transcript, assistantText: reply });

    logAccess({ requestId, endpoint: 'voice', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return new Response(
        JSON.stringify({ ok: true, data: { transcript, reply, lane, audio: audioChunks }, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );
};

export const config = { path: '/api/symp/v1/voice' };
