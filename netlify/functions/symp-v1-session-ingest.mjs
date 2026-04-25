// POST /api/symp/v1/session/ingest
//
// Module 3 — The Auto-Summariser.
// Called by Blaksyd (via proxy) immediately after any session ends (AI chat,
// AI call, human chat, human call). Generates a first-person summary via
// GPT-4o-mini and upserts-with-append into symp_daily_journals.
//
// Enforces the brief's rule: ONE ai_companion row + ONE human_connect row
// per user per day. Multiple sessions on the same day APPEND to the same row
// rather than creating a new one.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { upsertDailyJournal } from '../../symp-core/lib/supabase.mjs';
import { summariseSession } from '../../symp-core/lib/summariser.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES, SESSION_TYPE_TO_ENTRY_TYPE, SESSION_TYPES } = SympContract;
const VALID_SESSION_TYPES = new Set(Object.values(SESSION_TYPES));

function deriveJournalDate(endedAt) {
    // UTC date of session end. TZ-per-user comes later if needed; for v1 we
    // keep it simple so the UNIQUE(user_id,journal_date,entry_type) key is
    // deterministic across deployments.
    const d = endedAt ? new Date(endedAt) : new Date();
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'BAD_REQUEST' });
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    }

    const { user_id, session_type, session_id, transcript, started_at, ended_at } = parsed.data || {};

    if (!user_id) {
        return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);
    }
    if (!session_type || !VALID_SESSION_TYPES.has(session_type)) {
        return jsonError(ERROR_CODES.BAD_REQUEST, `session_type must be one of ${[...VALID_SESSION_TYPES].join(', ')}`, 400, requestId);
    }
    if (!Array.isArray(transcript)) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'transcript must be an array', 400, requestId);
    }

    const entryType    = SESSION_TYPE_TO_ENTRY_TYPE[session_type];
    const journalDate  = deriveJournalDate(ended_at);

    // Empty transcript → nothing to summarise, but still return 200 so the
    // client doesn't treat it as an error.
    if (transcript.length === 0) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return jsonSuccess({
            skipped:      true,
            reason:       'empty_transcript',
            entry_type:   entryType,
            journal_date: journalDate,
        }, requestId);
    }

    // ── 1. Summarise via GPT ─────────────────────────────────────────────
    let summary, extracted;
    try {
        const result = await summariseSession({
            sessionType: session_type,
            transcript,
            startedAt:   started_at,
            endedAt:     ended_at,
        });
        summary   = result.summary;
        extracted = result.extracted;
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
        return jsonError(ERROR_CODES.UPSTREAM_FAILED, `Summarisation failed: ${e.message || e}`, 502, requestId);
    }

    if (!summary || !summary.trim()) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return jsonSuccess({
            skipped:      true,
            reason:       'empty_summary',
            entry_type:   entryType,
            journal_date: journalDate,
        }, requestId);
    }

    // Header line to distinguish appended chunks when multiple sessions share
    // a day. Mirrors Blaksyd's own journal-append style.
    const header  = `(${session_type}${session_id ? ' · ' + session_id.slice(0, 8) : ''}${ended_at ? ' · ' + new Date(ended_at).toISOString().slice(11, 16) + 'Z' : ''})`;
    const payload = `${header}\n${summary.trim()}`;

    // ── 2. Upsert-append into symp_daily_journals ────────────────────────
    let upsertRes;
    try {
        upsertRes = await upsertDailyJournal({
            userId:      user_id,
            journalDate,
            entryType,
            newContent:  payload,
        });
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `DB upsert failed: ${e.message || e}`, 500, requestId);
    }

    if (!upsertRes.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `DB upsert rejected: ${JSON.stringify(upsertRes.error)}`, 500, requestId);
    }

    logAccess({ requestId, endpoint: ENDPOINTS.SESSION_INGEST, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return jsonSuccess({
        summary_id:   upsertRes.id,
        entry_type:   entryType,
        journal_date: journalDate,
        action:       upsertRes.action,   // 'created' | 'appended'
        summary,                          // full journal text — lets callers reuse it (e.g. Blaksyd's user-facing journals)
        extracted,
    }, requestId);
};

export const config = { path: '/api/symp/v1/session/ingest' };
