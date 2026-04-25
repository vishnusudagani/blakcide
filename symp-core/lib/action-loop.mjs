// Proactive Intervention Engine — the "Action Loop".
//
// Two surfaces:
//
//   scanAndQueue()  — called by an hourly CRON. Scans every active user's
//                     vibe state + recent events and queues triggers into
//                     symp_action_loop where appropriate.
//
//   fireDue()       — called by the same CRON immediately after scanAndQueue().
//                     Pops pending triggers whose scheduled_for has passed,
//                     calls the proactive-checkin endpoint, marks status.
//
// Triggers we currently emit:
//
//   morning_sweep      one per active user per day, scheduled at 07:30 local.
//   distress_pattern   3+ consecutive days with vibe_score < -30 → escalate.
//   streak_celebrate   7-day engagement streak.
//   silence_7d         no events from this user in 7+ days.
//
// Idempotency: the unique partial index on (user_id, trigger_type) WHERE
// status='pending' means re-running the scan is safe — duplicate INSERTs
// will conflict and be skipped.

import {
    listActiveUsersForActionLoop,
    fetchVibeState,
    fetchRecentJournals,
    fetchPendingActionRows,
    fetchUserActionRowsLast,
    insertActionRow,
    markActionRow,
} from './supabase.mjs';

const SYMP_INTERNAL_BASE = process.env.SYMP_INTERNAL_BASE  // optional override
    || process.env.URL                                    // Netlify-provided
    || '';

const SYMP_API_KEY = process.env.SYMP_API_KEY || '';

// ── Pattern detectors ─────────────────────────────────────────────────────

/** YYYY-MM-DD in IST (most users). Adjust if we ever need per-user TZ. */
function ymdIST(d = new Date()) {
    return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Build a Date for today 07:30 IST → returned as ISO UTC. */
function tomorrowMorningSweep() {
    // Tomorrow 07:30 IST = tomorrow 02:00 UTC
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 2, 0, 0));
    return t.toISOString();
}

/** Decide which triggers (if any) to queue for a single user. */
async function planForUser(userId) {
    const out = [];

    const vibe = await fetchVibeState(userId).catch(() => null);
    const journals = await fetchRecentJournals(userId, 14).catch(() => []);
    const recentActions = await fetchUserActionRowsLast(userId, 7).catch(() => []);

    // ── Distress pattern ────────────────────────────────────────────────
    if (vibe && (vibe.consecutive_low_days || 0) >= 3) {
        // Only fire once per 5 days to avoid pestering users in a rough patch.
        const fired = recentActions.find(r =>
            r.trigger_type === 'distress_pattern' &&
            r.fired_at &&
            (Date.now() - new Date(r.fired_at).getTime()) < 5 * 86400_000
        );
        if (!fired) {
            out.push({
                trigger_type:  'distress_pattern',
                scheduled_for: new Date(Date.now() + 30 * 60_000).toISOString(), // +30min
                payload: {
                    reason:           `consecutive_low_days=${vibe.consecutive_low_days}`,
                    vibe_snapshot:    vibe,
                    suggested_intent: 'escalate_to_human',
                },
            });
        }
    }

    // ── Streak celebrate ────────────────────────────────────────────────
    if (vibe && (vibe.streak_days || 0) >= 7 && (vibe.streak_days % 7 === 0)) {
        const fired = recentActions.find(r =>
            r.trigger_type === 'streak_celebrate' &&
            r.fired_at && (Date.now() - new Date(r.fired_at).getTime()) < 6 * 86400_000
        );
        if (!fired) {
            out.push({
                trigger_type:  'streak_celebrate',
                scheduled_for: new Date(Date.now() + 60 * 60_000).toISOString(), // +1h
                payload: {
                    reason:           `streak_days=${vibe.streak_days}`,
                    vibe_snapshot:    vibe,
                    suggested_intent: 'celebrate',
                },
            });
        }
    }

    // ── Silence 7d ──────────────────────────────────────────────────────
    if (journals.length === 0 || (vibe && vibe.updated_at && (Date.now() - new Date(vibe.updated_at).getTime()) > 7 * 86400_000)) {
        const fired = recentActions.find(r =>
            r.trigger_type === 'silence_7d' &&
            r.fired_at && (Date.now() - new Date(r.fired_at).getTime()) < 7 * 86400_000
        );
        if (!fired) {
            out.push({
                trigger_type:  'silence_7d',
                scheduled_for: new Date().toISOString(), // immediate
                payload: {
                    reason:           'no recent activity',
                    vibe_snapshot:    vibe || null,
                    suggested_intent: 'gentle_nudge',
                },
            });
        }
    }

    // ── Morning sweep ───────────────────────────────────────────────────
    // One per user per day. We only queue if we don't already have today's.
    const todaysSweep = recentActions.find(r =>
        r.trigger_type === 'morning_sweep' &&
        r.scheduled_for && r.scheduled_for.slice(0, 10) === ymdIST().slice(0, 10)
    );
    if (!todaysSweep) {
        out.push({
            trigger_type:  'morning_sweep',
            scheduled_for: tomorrowMorningSweep(),
            payload: {
                reason:           'daily-good-morning',
                vibe_snapshot:    vibe || null,
                suggested_intent: 'check_in',
            },
        });
    }

    return out;
}

/**
 * Scan all active users and queue pending triggers.
 * Returns { scanned, queued, skipped, errors }.
 */
export async function scanAndQueue({ limit = 500 } = {}) {
    const result = { scanned: 0, queued: 0, skipped: 0, errors: 0 };
    const users = await listActiveUsersForActionLoop({ limit }).catch(() => []);
    for (const u of users) {
        result.scanned++;
        try {
            const plan = await planForUser(u.user_id);
            for (const trigger of plan) {
                const ins = await insertActionRow({ userId: u.user_id, ...trigger });
                if (ins.ok) result.queued++;
                else        result.skipped++;     // most likely the unique index caught a dupe
            }
        } catch (e) {
            console.warn(`[action-loop] plan failed for ${u.user_id}: ${e.message}`);
            result.errors++;
        }
    }
    return result;
}

/**
 * Fire all pending triggers whose scheduled_for has passed.
 * Calls /api/symp/v1/proactive-checkin per row, then marks fired/failed.
 */
export async function fireDue({ limit = 100 } = {}) {
    const result = { considered: 0, fired: 0, failed: 0 };
    if (!SYMP_INTERNAL_BASE || !SYMP_API_KEY) {
        console.warn('[action-loop] missing SYMP_INTERNAL_BASE or SYMP_API_KEY — cannot fire');
        return result;
    }

    const due = await fetchPendingActionRows({ now: new Date().toISOString(), limit }).catch(() => []);
    for (const row of due) {
        result.considered++;
        try {
            const res = await fetch(`${SYMP_INTERNAL_BASE}/api/symp/v1/proactive-checkin`, {
                method: 'POST',
                headers: {
                    'Content-Type':   'application/json',
                    'x-symp-api-key': SYMP_API_KEY,
                },
                body: JSON.stringify({
                    user_id: row.user_id,
                    trigger: row.trigger_type,
                }),
                signal: AbortSignal.timeout(20_000),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok) {
                await markActionRow(row.id, { status: 'fired', fired_at: new Date().toISOString(), result: data.data || null });
                result.fired++;
            } else {
                await markActionRow(row.id, { status: 'failed', fired_at: new Date().toISOString(), result: { http: res.status, body: data } });
                result.failed++;
            }
        } catch (e) {
            await markActionRow(row.id, { status: 'failed', fired_at: new Date().toISOString(), result: { error: e.message || String(e) } }).catch(() => {});
            result.failed++;
        }
    }
    return result;
}

/**
 * One-shot: scan + fire. CRON entry point.
 */
export async function runOnce(opts = {}) {
    const queued = await scanAndQueue(opts);
    const fired  = await fireDue(opts);
    return { queued, fired };
}
