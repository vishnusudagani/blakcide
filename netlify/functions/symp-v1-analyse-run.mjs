// POST /api/symp/v1/analyse/run
//
// Module 4 — Lazy-loaded Omniscient Analyser.
//
// Called silently after login (or manually re-run with { force: true }).
// Picks a target date (defaults to "yesterday UTC"), checks whether we've
// already analysed that day for this user, and if not, pulls all
// symp_daily_journals rows for that date, runs the strict-JSON analyser, and
// upserts the result into symp_vault_profiles.symp_analysis.
//
// Idempotency: if last_analyzed_at is newer than midnight-after-target-date
// AND the existing analysis already covered target date or later, we skip.
// Pass { force: true } to override.
//
// Empty-day skip: if no journal rows exist for the target date we return
// { skipped: true, reason: 'no_data' } and do NOT touch the Vault.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import {
    fetchJournalsByDate, fetchVaultProfile, upsertVaultAnalysis,
} from '../../symp-core/lib/supabase.mjs';
import { analyseDailyJournals } from '../../symp-core/lib/analyser.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES } = SympContract;

function yesterdayUtc() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

// True if the user has already been analysed AT OR AFTER the boundary that
// would include `targetDate`. We use "midnight UTC after targetDate" so that a
// run done at 02:00 UTC on day+1 counts as covering that day.
function alreadyCovered(vaultProfile, targetDate) {
    if (!vaultProfile?.last_analyzed_at) return false;
    const boundary = new Date(`${targetDate}T00:00:00Z`).getTime() + 86400000;
    return new Date(vaultProfile.last_analyzed_at).getTime() >= boundary;
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    }

    const { user_id, date, force = false } = parsed.data || {};
    if (!user_id) {
        return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);
    }

    const targetDate = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
        ? date
        : yesterdayUtc();

    // ── 1. Idempotency check ──────────────────────────────────────────────
    let vaultProfile = null;
    try { vaultProfile = await fetchVaultProfile(user_id); }
    catch (e) { console.warn('[analyse-run] vault read failed:', e.message); }

    if (!force && alreadyCovered(vaultProfile, targetDate)) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return jsonSuccess({
            skipped:        true,
            reason:         'already_analysed',
            analysis_date:  targetDate,
            analysis:       vaultProfile?.symp_analysis || null,
        }, requestId);
    }

    // ── 2. Pull the day's journal rows ────────────────────────────────────
    let rows;
    try { rows = await fetchJournalsByDate(user_id, targetDate); }
    catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `Vault read failed: ${e.message || e}`, 500, requestId);
    }

    if (!rows.length) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return jsonSuccess({
            skipped:       true,
            reason:        'no_data',
            analysis_date: targetDate,
        }, requestId);
    }

    // ── 3. Run the analyser ───────────────────────────────────────────────
    let analysis;
    try {
        const result = await analyseDailyJournals({ journalDate: targetDate, rows });
        analysis = result.analysis;
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
        return jsonError(ERROR_CODES.UPSTREAM_FAILED, `Analyser failed: ${e.message || e}`, 502, requestId);
    }

    // ── 4. Persist to Vault ───────────────────────────────────────────────
    // We stamp the analysed-for date inside the JSON so downstream readers
    // know which day this snapshot is "of", regardless of when it was run.
    const stamped = { ...analysis, _analysed_for: targetDate, _generated_at: new Date().toISOString() };

    let upsert;
    try { upsert = await upsertVaultAnalysis({ userId: user_id, analysis: stamped }); }
    catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `Vault write failed: ${e.message || e}`, 500, requestId);
    }
    if (!upsert.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `Vault write rejected: ${JSON.stringify(upsert.error)}`, 500, requestId);
    }

    logAccess({ requestId, endpoint: ENDPOINTS.ANALYSE_RUN, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return jsonSuccess({
        skipped:       false,
        analysis_date: targetDate,
        action:        upsert.action,    // 'created' | 'updated'
        analysis:      stamped,
    }, requestId);
};

export const config = { path: '/api/symp/v1/analyse/run' };
