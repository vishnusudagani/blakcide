// Service-role REST helpers for Symp.ai. Uses fetch() directly against
// PostgREST so there's no dependency on @supabase/supabase-js (repo has no
// package.json and we want to keep the dep surface at zero for Netlify cold
// starts).
//
// All helpers are server-side only — they authenticate with
// SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. Never expose these functions
// or their env vars to any browser-reachable surface.

const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function requireEnv() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('[symp-core/supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    }
}

async function sbFetch(path, { method = 'GET', body, prefer } = {}) {
    requireEnv();
    const headers = {
        'apikey':        SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
    };
    if (prefer) headers['Prefer'] = prefer;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, status: res.status, data };
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function fetchBlaksydProfile(userId) {
    const { ok, data } = await sbFetch(
        `profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,bio,user_memory`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function fetchVaultProfile(userId) {
    const { ok, data } = await sbFetch(
        `symp_vault_profiles?user_id=eq.${encodeURIComponent(userId)}&select=symp_analysis,last_analyzed_at,updated_at`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function fetchRecentJournals(userId, days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { ok, data } = await sbFetch(
        `symp_daily_journals?user_id=eq.${encodeURIComponent(userId)}` +
        `&journal_date=gte.${since}` +
        `&order=journal_date.desc` +
        `&select=journal_date,entry_type,summary_content`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

/**
 * Fetch journal rows OLDER than `recentDays` whose summary_content matches a
 * keyword. Used by the `search_vault` tool — recent entries are already in
 * the immediate-context block, so we look further back.
 *
 * Uses PostgREST ILIKE (case-insensitive substring). For richer semantics
 * later, swap this for a pgvector embedding match without changing the
 * caller signature.
 */
export async function fetchOlderJournals(userId, query, maxResults = 5, recentDays = 3) {
    const cutoff = new Date(Date.now() - recentDays * 86400000).toISOString().slice(0, 10);
    const escaped = String(query || '').replace(/[%_,]/g, ' ').trim();
    if (!escaped) return [];
    const pattern = `*${escaped}*`;
    const { ok, data } = await sbFetch(
        `symp_daily_journals?user_id=eq.${encodeURIComponent(userId)}` +
        `&journal_date=lt.${cutoff}` +
        `&summary_content=ilike.${encodeURIComponent(pattern)}` +
        `&order=journal_date.desc` +
        `&limit=${maxResults}` +
        `&select=journal_date,entry_type,summary_content`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

// Fetch all journal rows for a single date (used by the analyser, which works
// one day at a time so the LLM context stays bounded).
export async function fetchJournalsByDate(userId, journalDate) {
    const { ok, data } = await sbFetch(
        `symp_daily_journals?user_id=eq.${encodeURIComponent(userId)}` +
        `&journal_date=eq.${journalDate}` +
        `&select=entry_type,summary_content,updated_at`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

// ── Writes ──────────────────────────────────────────────────────────────

/**
 * Upsert-with-append into symp_daily_journals.
 *
 * The deployed UNIQUE constraint on (user_id, journal_date, entry_type)
 * enforces one row per bucket per day. PostgREST's on_conflict upsert can't
 * do append semantics (it replaces), so we do a select-then-patch-or-insert.
 * Two round-trips, but correct and atomic-enough for our volume.
 *
 * Returns { ok, action:'created'|'appended', id }.
 */
export async function upsertDailyJournal({ userId, journalDate, entryType, newContent }) {
    const existing = await sbFetch(
        `symp_daily_journals?user_id=eq.${encodeURIComponent(userId)}` +
        `&journal_date=eq.${journalDate}` +
        `&entry_type=eq.${entryType}` +
        `&select=id,summary_content`
    );

    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
        const row    = existing.data[0];
        const merged = row.summary_content
            ? `${row.summary_content}\n\n---\n\n${newContent}`
            : newContent;
        const upd = await sbFetch(
            `symp_daily_journals?id=eq.${row.id}`,
            {
                method:  'PATCH',
                body:    { summary_content: merged, updated_at: new Date().toISOString() },
                prefer:  'return=representation',
            }
        );
        return { ok: upd.ok, action: 'appended', id: row.id };
    }

    const ins = await sbFetch('symp_daily_journals', {
        method:  'POST',
        body:    {
            user_id:         userId,
            journal_date:    journalDate,
            entry_type:      entryType,
            summary_content: newContent,
        },
        prefer:  'return=representation',
    });
    const insertedId = (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0].id : null;
    return { ok: ins.ok, action: 'created', id: insertedId, error: ins.ok ? null : ins.data };
}

/**
 * Upsert the user's symp_vault_profiles row with a new symp_analysis JSONB
 * payload and bump last_analyzed_at. Creates the row if it doesn't exist yet
 * (first-time analysis for a user).
 *
 * Returns { ok, action:'created'|'updated' }.
 */
export async function upsertVaultAnalysis({ userId, analysis }) {
    const nowIso = new Date().toISOString();
    const existing = await sbFetch(
        `symp_vault_profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id`
    );

    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
        const upd = await sbFetch(
            `symp_vault_profiles?user_id=eq.${encodeURIComponent(userId)}`,
            {
                method: 'PATCH',
                body:   {
                    symp_analysis:    analysis,
                    last_analyzed_at: nowIso,
                    updated_at:       nowIso,
                },
                prefer: 'return=representation',
            }
        );
        return { ok: upd.ok, action: 'updated', error: upd.ok ? null : upd.data };
    }

    const ins = await sbFetch('symp_vault_profiles', {
        method: 'POST',
        body:   {
            user_id:          userId,
            symp_analysis:    analysis,
            last_analyzed_at: nowIso,
        },
        prefer: 'return=representation',
    });
    return { ok: ins.ok, action: 'created', error: ins.ok ? null : ins.data };
}

// ── Vibe state / events ─────────────────────────────────────────────────

export async function fetchVibeState(userId) {
    const { ok, data } = await sbFetch(
        `symp_vibe_state?user_id=eq.${encodeURIComponent(userId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function upsertVibeState(state) {
    const { user_id, ...rest } = state;
    if (!user_id) throw new Error('upsertVibeState: user_id required');
    const existing = await sbFetch(
        `symp_vibe_state?user_id=eq.${encodeURIComponent(user_id)}&select=user_id`
    );
    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
        const upd = await sbFetch(
            `symp_vibe_state?user_id=eq.${encodeURIComponent(user_id)}`,
            { method: 'PATCH', body: rest, prefer: 'return=representation' }
        );
        return { ok: upd.ok, action: 'updated' };
    }
    const ins = await sbFetch('symp_vibe_state', {
        method:  'POST',
        body:    { user_id, ...rest },
        prefer:  'return=representation',
    });
    return { ok: ins.ok, action: 'created' };
}

export async function insertVibeEvent({ userId, source, sourceSessionId, vibeDelta, vibeSnapshot }) {
    const ins = await sbFetch('symp_vibe_events', {
        method:  'POST',
        body:    {
            user_id:           userId,
            source,
            source_session_id: sourceSessionId,
            vibe_delta:        vibeDelta,
            vibe_snapshot:     vibeSnapshot,
        },
        prefer:  'return=representation',
    });
    return (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0].id : null;
}

// ── Persona state ───────────────────────────────────────────────────────

export async function fetchPersonaState(userId) {
    const { ok, data } = await sbFetch(
        `symp_persona_state?user_id=eq.${encodeURIComponent(userId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function upsertPersonaState({ userId, activePersona, locked, swapHistory }) {
    if (!userId) throw new Error('upsertPersonaState: userId required');
    const existing = await sbFetch(
        `symp_persona_state?user_id=eq.${encodeURIComponent(userId)}&select=user_id`
    );
    const body = {
        active_persona:  activePersona,
        last_swapped_at: new Date().toISOString(),
    };
    if (typeof locked === 'boolean')      body.locked = locked;
    if (Array.isArray(swapHistory))       body.swap_history = swapHistory;

    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
        const upd = await sbFetch(
            `symp_persona_state?user_id=eq.${encodeURIComponent(userId)}`,
            { method: 'PATCH', body, prefer: 'return=representation' }
        );
        return { ok: upd.ok, action: 'updated' };
    }
    const ins = await sbFetch('symp_persona_state', {
        method: 'POST', body: { user_id: userId, ...body }, prefer: 'return=representation',
    });
    return { ok: ins.ok, action: 'created' };
}

// ── Action loop ─────────────────────────────────────────────────────────

/**
 * Best-effort list of "active" users for the action loop. We define active
 * as having any vibe event in the last 30 days. For v1 we read from
 * symp_vibe_state ordered by updated_at desc.
 */
export async function listActiveUsersForActionLoop({ limit = 500 } = {}) {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const { ok, data } = await sbFetch(
        `symp_vibe_state?updated_at=gte.${cutoff}&order=updated_at.desc&limit=${limit}&select=user_id,updated_at`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function fetchUserActionRowsLast(userId, days = 7) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const { ok, data } = await sbFetch(
        `symp_action_loop?user_id=eq.${encodeURIComponent(userId)}` +
        `&created_at=gte.${cutoff}` +
        `&order=created_at.desc` +
        `&select=id,trigger_type,scheduled_for,status,fired_at,created_at`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function fetchPendingActionRows({ now, limit = 100 }) {
    const { ok, data } = await sbFetch(
        `symp_action_loop?status=eq.pending&scheduled_for=lte.${encodeURIComponent(now)}` +
        `&order=scheduled_for.asc&limit=${limit}` +
        `&select=id,user_id,trigger_type,scheduled_for,payload`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function insertActionRow({ userId, trigger_type, scheduled_for, payload }) {
    const ins = await sbFetch('symp_action_loop', {
        method:  'POST',
        body:    { user_id: userId, trigger_type, scheduled_for, payload },
        prefer:  'return=representation',
    });
    return { ok: ins.ok, id: (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0].id : null };
}

export async function markActionRow(id, fields) {
    const upd = await sbFetch(
        `symp_action_loop?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', body: fields, prefer: 'return=representation' }
    );
    return upd.ok;
}

// ── Listener briefs ─────────────────────────────────────────────────────

export async function fetchListenerBrief(connectSessionId) {
    const { ok, data } = await sbFetch(
        `symp_listener_briefs?connect_session_id=eq.${encodeURIComponent(connectSessionId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function insertListenerBrief({ connectSessionId, userId, listenerId, brief }) {
    // Idempotent: ON CONFLICT (connect_session_id) — but PostgREST upsert is
    // fragile; we do select-then-insert.
    const existing = await fetchListenerBrief(connectSessionId);
    if (existing) return { ok: true, action: 'exists', id: existing.id };
    const ins = await sbFetch('symp_listener_briefs', {
        method:  'POST',
        body:    {
            connect_session_id: connectSessionId,
            user_id:            userId,
            listener_id:        listenerId,
            brief,
        },
        prefer:  'return=representation',
    });
    return {
        ok: ins.ok,
        action: 'created',
        id: (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0].id : null,
    };
}
