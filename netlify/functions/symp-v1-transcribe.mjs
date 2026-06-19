// POST /api/symp/v1/transcribe — audio → text via Whisper.
// Authenticated gateway wrapper. Accepts base64 audio, forwards to OpenAI
// Whisper, returns { text, language }.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';
import { transcribe as groqTranscribe } from '../../symp-core/lib/voice.mjs';

const { ENDPOINTS, ERROR_CODES } = SympContract;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.TRANSCRIBE, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    }

    const { user_id, audioBase64, mimeType, language_hint } = parsed.data || {};
    if (!audioBase64) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'audioBase64 is required', 400, requestId);
    }

    // Pick a filename extension so the STT model treats the upload correctly.
    const ext = !mimeType                  ? 'webm'
              : mimeType.includes('mp4')   ? 'm4a'
              : mimeType.includes('mpeg')  ? 'mp3'
              : mimeType.includes('ogg')   ? 'ogg'
              : mimeType.includes('wav')   ? 'wav'
              :                              'webm';

    try {
        // Groq Whisper (free, multilingual — verified for Telugu/Hindi). Replaces
        // the old OpenAI Whisper path, whose key (BLAKCIDE_OPENAI_KEY) was dead, so
        // voice notes came back empty.
        const bin = Buffer.from(audioBase64, 'base64');
        const text = await groqTranscribe(bin, {
            mimetype: mimeType || 'audio/webm',
            filename: `audio.${ext}`,
            language: language_hint || undefined,
        });
        logAccess({ requestId, endpoint: ENDPOINTS.TRANSCRIBE, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id || null });
        return jsonSuccess({ text: text || '', language: language_hint || null }, requestId);
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.TRANSCRIBE, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id || null, errorCode: 'UPSTREAM_FAILED' });
        return jsonError(ERROR_CODES.UPSTREAM_FAILED, `Transcription failed: ${e.message || e}`, 502, requestId);
    }
};

export const config = { path: '/api/symp/v1/transcribe' };
