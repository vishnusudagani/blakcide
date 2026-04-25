// POST /api/symp/v1/transcribe — audio → text via Whisper.
// Authenticated gateway wrapper. Accepts base64 audio, forwards to OpenAI
// Whisper, returns { text, language }.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

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

    const openaiKey = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        return jsonError(ERROR_CODES.INTERNAL_ERROR, 'OpenAI key not configured', 500, requestId);
    }

    // Pick filename extension so Whisper treats the upload correctly.
    const ext = !mimeType                  ? 'webm'
              : mimeType.includes('mp4')   ? 'm4a'
              : mimeType.includes('mpeg')  ? 'mp3'
              : mimeType.includes('ogg')   ? 'ogg'
              : mimeType.includes('wav')   ? 'wav'
              :                              'webm';

    try {
        const bin = Buffer.from(audioBase64, 'base64');
        const blob = new Blob([bin], { type: mimeType || 'audio/webm' });

        const form = new FormData();
        form.append('file',  blob, `audio.${ext}`);
        form.append('model', 'whisper-1');
        if (language_hint) form.append('language', language_hint);

        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}` },
            body:    form,
        });

        if (!res.ok) {
            const txt = await res.text();
            logAccess({ requestId, endpoint: ENDPOINTS.TRANSCRIBE, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id || null, errorCode: 'UPSTREAM_FAILED' });
            return jsonError(ERROR_CODES.UPSTREAM_FAILED, `Whisper failed: ${res.status} ${txt}`, 502, requestId);
        }

        const data = await res.json();
        logAccess({ requestId, endpoint: ENDPOINTS.TRANSCRIBE, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id || null });
        return jsonSuccess({
            text:     data.text || '',
            language: data.language || language_hint || null,
        }, requestId);
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.TRANSCRIBE, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id || null, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `Transcription error: ${e.message || e}`, 500, requestId);
    }
};

export const config = { path: '/api/symp/v1/transcribe' };
