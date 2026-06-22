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

// ── Per-persona memory (the character's own memory of one user) ──────────

export async function fetchPersonaMemory(userId, personaId) {
    if (!userId || !personaId) return '';
    const { ok, data } = await sbFetch(
        `symp_persona_memory?user_id=eq.${encodeURIComponent(userId)}&persona_id=eq.${encodeURIComponent(personaId)}&select=memory`
    );
    return (ok && Array.isArray(data) && data[0] && data[0].memory) ? data[0].memory : '';
}

export async function upsertPersonaMemory(userId, personaId, memory) {
    if (!userId || !personaId) return false;
    const body = { memory: String(memory || '').slice(0, 4000), updated_at: new Date().toISOString() };
    const existing = await sbFetch(
        `symp_persona_memory?user_id=eq.${encodeURIComponent(userId)}&persona_id=eq.${encodeURIComponent(personaId)}&select=user_id`
    );
    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
        const upd = await sbFetch(
            `symp_persona_memory?user_id=eq.${encodeURIComponent(userId)}&persona_id=eq.${encodeURIComponent(personaId)}`,
            { method: 'PATCH', body }
        );
        return upd.ok;
    }
    const ins = await sbFetch('symp_persona_memory', {
        method: 'POST',
        body: { user_id: userId, persona_id: personaId, ...body },
    });
    return ins.ok;
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function fetchBlaksydProfile(userId) {
    const { ok, data } = await sbFetch(
        `profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,bio,user_memory`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

/**
 * Patch the user's rolling memory (profiles.user_memory). PATCHes the existing
 * row created at sign-up. Best-effort: returns false if the row/column is
 * missing — the memory updater never blocks or breaks a chat.
 */
export async function updateUserMemory(userId, memory) {
    // Update the existing row first (preserves username / full_name / etc.).
    const upd = await sbFetch(
        `profiles?id=eq.${encodeURIComponent(userId)}`,
        { method: 'PATCH', body: { user_memory: memory }, prefer: 'return=representation' }
    );
    if (upd.ok && Array.isArray(upd.data) && upd.data.length) return true;
    // No row yet (profile never created at sign-up) → create a minimal one so
    // memory persists for EVERY user. profiles requires id + username (both NOT
    // NULL); everything else is nullable/defaulted.
    const ins = await sbFetch('profiles', {
        method: 'POST',
        body:   { id: userId, username: `user_${userId.slice(0, 8)}`, user_memory: memory },
        prefer: 'return=minimal',
    });
    return ins.ok;
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

// ── Knowledge profile (structured "what Blak knows about you") ────────────
//
// Service-role helpers for the knowledge-extractor (writes) and the context
// engine (reads). The /beta/profile page reads/edits/deletes via the browser
// client under owner-only RLS — NOT through these.

export async function fetchKnowledgeFacts(userId) {
    const { ok, data } = await sbFetch(
        `symp_knowledge_facts?user_id=eq.${encodeURIComponent(userId)}` +
        `&order=area.asc,updated_at.desc` +
        `&select=id,area,key,label,value,source,confidence,status,evidence,evidence_at,source_kind,source_ref,` +
        `visibility,never_raise,pinned,archived,last_confirmed_at,valid_until,updated_at,last_seen_at`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

/**
 * A subtle, non-clinical read of recent mood check-ins (mood_logs) for the
 * context engine. NEVER a "score" or diagnosis — just a gentle tone cue.
 * Returns { n, dominant, latest, counts } or null.
 */
export async function fetchRecentMoodSummary(userId, { days = 14 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { ok, data } = await sbFetch(
        `mood_logs?user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(since)}` +
        `&select=mood,created_at&order=created_at.desc&limit=60`
    );
    if (!ok || !Array.isArray(data) || !data.length) return null;
    const counts = {};
    for (const r of data) counts[r.mood] = (counts[r.mood] || 0) + 1;
    let dominant = null, max = 0;
    for (const [m, c] of Object.entries(counts)) if (c > max) { max = c; dominant = m; }
    return { n: data.length, dominant, latest: data[0].mood, counts };
}

/**
 * Upsert one extracted fact, keyed by (user_id, area, key).
 *  - If the existing row was edited by the user (status='user_edited'), we
 *    NEVER overwrite its value — only bump last_seen_at (the user owns it).
 *  - Otherwise we refine value/label/confidence/source/evidence + bump dates.
 * Returns { ok, action:'created'|'updated'|'locked-skip'|'noop' }.
 */
export async function upsertKnowledgeFact({ userId, area, key, label, value, source = 'blak', confidence = 0.6, evidence = null, evidenceAt = null, sourceKind = null, sourceRef = null }) {
    if (!userId || !area || !key || !value) return { ok: false, action: 'noop' };
    const u = encodeURIComponent(userId);
    const a = encodeURIComponent(area);
    const k = encodeURIComponent(key);
    const nowIso = new Date().toISOString();

    const existing = await sbFetch(
        `symp_knowledge_facts?user_id=eq.${u}&area=eq.${a}&key=eq.${k}&select=id,status,value`
    );
    const row = (existing.ok && Array.isArray(existing.data) && existing.data[0]) ? existing.data[0] : null;

    if (row) {
        if (row.status === 'user_edited') {
            await sbFetch(`symp_knowledge_facts?id=eq.${row.id}`, {
                method: 'PATCH', body: { last_seen_at: nowIso }, prefer: 'return=minimal',
            });
            return { ok: true, action: 'locked-skip' };
        }
        const body = { value, source, confidence, last_seen_at: nowIso };
        if (label)      body.label       = label;
        if (evidence)   body.evidence    = evidence;
        if (evidenceAt) body.evidence_at = evidenceAt;
        if (sourceKind) body.source_kind = sourceKind;
        if (sourceRef)  body.source_ref  = sourceRef;
        const upd = await sbFetch(`symp_knowledge_facts?id=eq.${row.id}`, {
            method: 'PATCH', body, prefer: 'return=minimal',
        });
        // Versioning (#7): keep the prior value when Blak genuinely changes a fact.
        if (upd.ok && row.value && row.value !== value) {
            await recordFactHistory({
                userId, factId: row.id, area, key,
                oldValue: row.value, newValue: value, changedBy: 'blak', reason: sourceKind || null,
            }).catch(() => {});
        }
        return { ok: upd.ok, action: 'updated' };
    }

    const ins = await sbFetch('symp_knowledge_facts', {
        method: 'POST',
        body:   {
            user_id: userId, area, key, label: label || null, value, source, confidence,
            evidence: evidence || null, evidence_at: evidenceAt || null,
            source_kind: sourceKind || null, source_ref: sourceRef || null,
        },
        prefer: 'return=minimal',
    });
    return { ok: ins.ok, action: 'created', error: ins.ok ? null : ins.data };
}

// ── Knowledge: entities (people / pets / places as first-class — #1, #37) ──
export async function fetchEntities(userId) {
    const { ok, data } = await sbFetch(
        `symp_knowledge_entities?user_id=eq.${encodeURIComponent(userId)}` +
        `&order=importance.desc,updated_at.desc&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function upsertEntity({ userId, kind, name, role = null, relation = null, notes = null, avatarUrl = null, birthday = null, sentiment = null, importance = 0.5, sensitive = false, source = 'blak', confidence = 0.6, visibility = 'shared' }) {
    if (!userId || !kind || !name) return { ok: false, action: 'noop' };
    const u = encodeURIComponent(userId), kk = encodeURIComponent(kind), nn = encodeURIComponent(name);
    const nowIso = new Date().toISOString();
    const existing = await sbFetch(
        `symp_knowledge_entities?user_id=eq.${u}&kind=eq.${kk}&name=eq.${nn}&select=id,status`
    );
    const row = (existing.ok && Array.isArray(existing.data) && existing.data[0]) ? existing.data[0] : null;
    if (row) {
        if (row.status === 'user_edited') {
            await sbFetch(`symp_knowledge_entities?id=eq.${row.id}`, { method: 'PATCH', body: { last_seen_at: nowIso }, prefer: 'return=minimal' });
            return { ok: true, action: 'locked-skip' };
        }
        const body = { last_seen_at: nowIso, source, confidence };
        if (role != null)       body.role       = role;
        if (relation != null)   body.relation   = relation;
        if (notes != null)      body.notes      = notes;
        if (avatarUrl != null)  body.avatar_url = avatarUrl;
        if (birthday != null)   body.birthday   = birthday;
        if (sentiment != null)  body.sentiment  = sentiment;
        if (importance != null) body.importance = importance;
        const upd = await sbFetch(`symp_knowledge_entities?id=eq.${row.id}`, { method: 'PATCH', body, prefer: 'return=minimal' });
        return { ok: upd.ok, action: 'updated' };
    }
    const ins = await sbFetch('symp_knowledge_entities', {
        method: 'POST',
        body: { user_id: userId, kind, name, role, relation, notes, avatar_url: avatarUrl, birthday, sentiment, importance, sensitive, visibility, source, confidence },
        prefer: 'return=minimal',
    });
    return { ok: ins.ok, action: 'created', error: ins.ok ? null : ins.data };
}

// ── Knowledge: events (dated facts → timeline & countdowns — #2, #8) ───────
export async function fetchEvents(userId) {
    const { ok, data } = await sbFetch(
        `symp_knowledge_events?user_id=eq.${encodeURIComponent(userId)}` +
        `&order=occurred_on.desc.nullslast&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function upsertEvent({ userId, title, kind = 'event', occurredOn = null, occurredAt = null, endOn = null, allDay = true, recurrence = null, entityId = null, factId = null, notes = null, source = 'blak', sourceKind = null, sourceRef = null, confidence = 0.6, visibility = 'shared' }) {
    if (!userId || !title) return { ok: false, action: 'noop' };
    const u = encodeURIComponent(userId), t = encodeURIComponent(title);
    const onClause = occurredOn ? `&occurred_on=eq.${encodeURIComponent(occurredOn)}` : '&occurred_on=is.null';
    const existing = await sbFetch(`symp_knowledge_events?user_id=eq.${u}&title=eq.${t}${onClause}&select=id,status`);
    const row = (existing.ok && Array.isArray(existing.data) && existing.data[0]) ? existing.data[0] : null;
    if (row) {
        if (row.status === 'user_edited') return { ok: true, action: 'locked-skip' };
        const body = { kind, occurred_at: occurredAt, end_on: endOn, all_day: allDay, recurrence, entity_id: entityId, fact_id: factId, notes, confidence, visibility };
        const upd = await sbFetch(`symp_knowledge_events?id=eq.${row.id}`, { method: 'PATCH', body, prefer: 'return=minimal' });
        return { ok: upd.ok, action: 'updated' };
    }
    const ins = await sbFetch('symp_knowledge_events', {
        method: 'POST',
        body: { user_id: userId, title, kind, occurred_on: occurredOn, occurred_at: occurredAt, end_on: endOn, all_day: allDay, recurrence, entity_id: entityId, fact_id: factId, notes, source, source_kind: sourceKind, source_ref: sourceRef, confidence, visibility },
        prefer: 'return=minimal',
    });
    return { ok: ins.ok, action: 'created', error: ins.ok ? null : ins.data };
}

// ── Knowledge: fact history (versioning — #7) ─────────────────────────────
export async function recordFactHistory({ userId, factId = null, area = null, key = null, oldValue = null, newValue = null, changedBy = 'blak', reason = null }) {
    if (!userId) return { ok: false };
    const ins = await sbFetch('symp_knowledge_fact_history', {
        method: 'POST',
        body: { user_id: userId, fact_id: factId, area, key, old_value: oldValue, new_value: newValue, changed_by: changedBy, reason },
        prefer: 'return=minimal',
    });
    return { ok: ins.ok };
}

export async function fetchFactHistory(userId, factId) {
    const { ok, data } = await sbFetch(
        `symp_knowledge_fact_history?user_id=eq.${encodeURIComponent(userId)}&fact_id=eq.${encodeURIComponent(factId)}` +
        `&order=changed_at.desc&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

// ── Knowledge: tombstones ("forget & don't relearn" — #20) ────────────────
export async function fetchTombstones(userId) {
    const { ok, data } = await sbFetch(
        `symp_knowledge_tombstones?user_id=eq.${encodeURIComponent(userId)}&select=scope,area,key,value_norm`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function addTombstone({ userId, scope = 'fact', area = null, key = null, valueNorm = null, reason = null }) {
    if (!userId) return { ok: false };
    const ins = await sbFetch('symp_knowledge_tombstones', {
        method: 'POST',
        body: { user_id: userId, scope, area, key, value_norm: valueNorm, reason },
        prefer: 'return=minimal',
    });
    return { ok: ins.ok };
}

// ── Profile settings (consent-first toggles — #18, #46–50) ────────────────
export async function fetchProfileSettings(userId) {
    const { ok, data } = await sbFetch(
        `symp_profile_settings?user_id=eq.${encodeURIComponent(userId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

// ── Profile synthesis ("About you" narrative cache — #36) ─────────────────
export async function fetchSynthesis(userId) {
    const { ok, data } = await sbFetch(
        `symp_profile_synthesis?user_id=eq.${encodeURIComponent(userId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function saveSynthesis({ userId, narrative, factCount = 0, model = null }) {
    if (!userId) return { ok: false };
    const up = await sbFetch('symp_profile_synthesis', {
        method: 'POST',
        body: { user_id: userId, narrative, fact_count: factCount, model, generated_at: new Date().toISOString() },
        prefer: 'return=minimal,resolution=merge-duplicates',
    });
    return { ok: up.ok };
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

// ── Fantasy personas (user-created characters) ────────────────────────────
// Read with the service role for the chat/call prompt builders. Always scope by
// BOTH id AND user_id so a caller can only ever load the user's own persona,
// even though the service key bypasses RLS (defence-in-depth — the handler has
// already verified user_id from the JWT).
export async function fetchFantasyPersona(userId, personaId) {
    if (!userId || !personaId) return null;
    const u = encodeURIComponent(userId);
    const p = encodeURIComponent(personaId);
    const { ok, data } = await sbFetch(
        `fantasy_personas?id=eq.${p}&user_id=eq.${u}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

// ── Persona-scoped facts (DOB for astrologer, religion for spiritual, …) ──

/**
 * Fetch the facts JSONB for one (user, persona). Returns {} if no row.
 */
export async function fetchPersonaFacts(userId, personaId) {
    const u = encodeURIComponent(userId);
    const p = encodeURIComponent(personaId);
    const { ok, data } = await sbFetch(
        `symp_persona_facts?user_id=eq.${u}&persona_id=eq.${p}&select=facts`
    );
    if (ok && Array.isArray(data) && data[0]) return data[0].facts || {};
    return {};
}

/**
 * Upsert the entire facts blob for one (user, persona). Caller is responsible
 * for merging with existing facts (the executor already does this).
 */
export async function upsertPersonaFacts({ userId, personaId, facts }) {
    if (!userId || !personaId) throw new Error('upsertPersonaFacts: userId+personaId required');
    const u = encodeURIComponent(userId);
    const p = encodeURIComponent(personaId);
    const existing = await sbFetch(
        `symp_persona_facts?user_id=eq.${u}&persona_id=eq.${p}&select=user_id`
    );
    const body = { facts: facts || {} };

    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
        const upd = await sbFetch(
            `symp_persona_facts?user_id=eq.${u}&persona_id=eq.${p}`,
            { method: 'PATCH', body, prefer: 'return=representation' }
        );
        return { ok: upd.ok, action: 'updated' };
    }
    const ins = await sbFetch('symp_persona_facts', {
        method: 'POST',
        body:   { user_id: userId, persona_id: personaId, ...body },
        prefer: 'return=representation',
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

// ── Nexus (Community Module) ────────────────────────────────────────────
//
// All helpers below talk to the nexus_* tables created in
// supabase/migrations/20260427_nexus.sql. They run service-role and bypass
// RLS — the proxy/auth layer guarantees the user_id passed in is the
// caller's authenticated id.

// — AI participant —
export async function fetchNexusAiIdentity() {
    const { ok, data } = await sbFetch('nexus_ai_identity?id=eq.1&select=*');
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

// — Communities —
export async function fetchNexusCommunity(communityId) {
    const { ok, data } = await sbFetch(
        `nexus_communities?id=eq.${encodeURIComponent(communityId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function fetchNexusCommunityBySlug(slug) {
    const { ok, data } = await sbFetch(
        `nexus_communities?slug=eq.${encodeURIComponent(slug)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function listNexusCommunities({ limit = 50, includeArchived = false } = {}) {
    const filter = includeArchived ? '' : '&archived_at=is.null';
    const { ok, data } = await sbFetch(
        `nexus_communities?select=*${filter}&order=created_at.desc&limit=${limit}`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function insertNexusCommunity(row) {
    const ins = await sbFetch('nexus_communities', {
        method: 'POST', body: row, prefer: 'return=representation',
    });
    return (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0] : null;
}

export async function joinNexusCommunity({ communityId, userId, joinResonance, role = 'member' }) {
    // Idempotent — duplicate (community_id, user_id) is a no-op via 409.
    const ins = await sbFetch('nexus_community_members', {
        method: 'POST',
        body:   { community_id: communityId, user_id: userId, join_resonance: joinResonance, role },
        prefer: 'resolution=ignore-duplicates,return=representation',
    });
    return ins.ok;
}

export async function leaveNexusCommunity({ communityId, userId }) {
    const del = await sbFetch(
        `nexus_community_members?community_id=eq.${encodeURIComponent(communityId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}`,
        { method: 'DELETE' }
    );
    return del.ok;
}

export async function listNexusMemberships(userId, { limit = 50 } = {}) {
    const { ok, data } = await sbFetch(
        `nexus_community_members?user_id=eq.${encodeURIComponent(userId)}` +
        `&order=joined_at.desc&limit=${limit}` +
        `&select=community_id,joined_at,join_resonance,role`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function listNexusMemberIds(communityId, { limit = 5000 } = {}) {
    const { ok, data } = await sbFetch(
        `nexus_community_members?community_id=eq.${encodeURIComponent(communityId)}` +
        `&select=user_id&limit=${limit}`
    );
    return (ok && Array.isArray(data)) ? data.map(r => r.user_id) : [];
}

// — Anonymous handles —
export async function fetchNexusHandle({ communityId, userId }) {
    const { ok, data } = await sbFetch(
        `nexus_anonymous_handles?community_id=eq.${encodeURIComponent(communityId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}&select=handle,avatar_seed`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function insertNexusHandle({ communityId, userId, handle, avatarSeed }) {
    const ins = await sbFetch('nexus_anonymous_handles', {
        method: 'POST',
        body:   { community_id: communityId, user_id: userId, handle, avatar_seed: avatarSeed },
        prefer: 'return=representation',
    });
    return ins.ok ? (Array.isArray(ins.data) ? ins.data[0] : null) : null;
}

export async function fetchNexusHandlesBulk({ communityId, userIds }) {
    if (!userIds || !userIds.length) return {};
    const inList = userIds.map(encodeURIComponent).join(',');
    const { ok, data } = await sbFetch(
        `nexus_anonymous_handles?community_id=eq.${encodeURIComponent(communityId)}` +
        `&user_id=in.(${inList})&select=user_id,handle,avatar_seed`
    );
    if (!ok || !Array.isArray(data)) return {};
    const map = {};
    for (const r of data) map[r.user_id] = { handle: r.handle, avatar_seed: r.avatar_seed };
    return map;
}

// — Vault embeddings —
export async function fetchNexusVaultEmbedding(userId) {
    const { ok, data } = await sbFetch(
        `nexus_vault_embeddings?user_id=eq.${encodeURIComponent(userId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function upsertNexusVaultEmbedding({ userId, embedding, sourceVersion }) {
    const existing = await fetchNexusVaultEmbedding(userId);
    const body = {
        embedding,                  // PostgREST accepts a JS array for vector when sent as JSON
        source_version: sourceVersion,
        computed_at:    new Date().toISOString(),
    };
    if (existing) {
        const upd = await sbFetch(
            `nexus_vault_embeddings?user_id=eq.${encodeURIComponent(userId)}`,
            { method: 'PATCH', body, prefer: 'return=representation' }
        );
        return upd.ok;
    }
    const ins = await sbFetch('nexus_vault_embeddings', {
        method: 'POST', body: { user_id: userId, ...body }, prefer: 'return=representation',
    });
    return ins.ok;
}

// — Resonance score cache —
export async function fetchResonanceScore({ viewerUserId, targetUserId }) {
    const { ok, data } = await sbFetch(
        `nexus_resonance_scores?viewer_user_id=eq.${encodeURIComponent(viewerUserId)}` +
        `&target_user_id=eq.${encodeURIComponent(targetUserId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function upsertResonanceScore({ viewerUserId, targetUserId, score, viewerVersion, targetVersion }) {
    const existing = await fetchResonanceScore({ viewerUserId, targetUserId });
    const body = {
        score,
        viewer_version: viewerVersion,
        target_version: targetVersion,
        computed_at:    new Date().toISOString(),
    };
    if (existing) {
        const upd = await sbFetch(
            `nexus_resonance_scores?viewer_user_id=eq.${encodeURIComponent(viewerUserId)}` +
            `&target_user_id=eq.${encodeURIComponent(targetUserId)}`,
            { method: 'PATCH', body, prefer: 'return=representation' }
        );
        return upd.ok;
    }
    const ins = await sbFetch('nexus_resonance_scores', {
        method: 'POST',
        body:   { viewer_user_id: viewerUserId, target_user_id: targetUserId, ...body },
        prefer: 'return=representation',
    });
    return ins.ok;
}

// — Posts —
export async function insertNexusPost(row) {
    const ins = await sbFetch('nexus_posts', {
        method: 'POST', body: row, prefer: 'return=representation',
    });
    return (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0] : null;
}

export async function fetchNexusPost(postId) {
    const { ok, data } = await sbFetch(
        `nexus_posts?id=eq.${encodeURIComponent(postId)}&select=*`
    );
    return (ok && Array.isArray(data) && data[0]) ? data[0] : null;
}

export async function patchNexusPost(postId, fields) {
    const upd = await sbFetch(
        `nexus_posts?id=eq.${encodeURIComponent(postId)}`,
        { method: 'PATCH', body: fields, prefer: 'return=representation' }
    );
    return upd.ok;
}

export async function listNexusPosts({ communityId, limit = 30, before }) {
    let q = `nexus_posts?community_id=eq.${encodeURIComponent(communityId)}` +
            `&is_soft_hidden=eq.false&order=created_at.desc&limit=${limit}` +
            `&select=*`;
    if (before) q += `&created_at=lt.${encodeURIComponent(before)}`;
    const { ok, data } = await sbFetch(q);
    return (ok && Array.isArray(data)) ? data : [];
}

export async function listZeroEngagementPosts({ olderThanIso, limit = 50 }) {
    const { ok, data } = await sbFetch(
        `nexus_posts?comment_count=eq.0&ai_replied_at=is.null&is_soft_hidden=eq.false` +
        `&created_at=lt.${encodeURIComponent(olderThanIso)}` +
        `&order=created_at.desc&limit=${limit}&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

export async function listPostsNeedingTldr({ minComments = 15, limit = 30 }) {
    const { ok, data } = await sbFetch(
        `nexus_posts?comment_count=gte.${minComments}&ai_tldr=is.null` +
        `&order=comment_count.desc&limit=${limit}&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

// — Comments —
export async function insertNexusComment(row) {
    const ins = await sbFetch('nexus_comments', {
        method: 'POST', body: row, prefer: 'return=representation',
    });
    return (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0] : null;
}

export async function listNexusComments({ postId, limit = 200 }) {
    const { ok, data } = await sbFetch(
        `nexus_comments?post_id=eq.${encodeURIComponent(postId)}` +
        `&is_soft_hidden=eq.false&order=created_at.asc&limit=${limit}&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
}

// — Impacts —
export async function insertNexusImpact(row) {
    const ins = await sbFetch('nexus_impacts', {
        method: 'POST', body: row,
        prefer: 'resolution=ignore-duplicates,return=representation',
    });
    return ins.ok;
}

export async function deleteNexusImpact({ userId, postId, commentId, impactType }) {
    let q = `nexus_impacts?user_id=eq.${encodeURIComponent(userId)}` +
            `&impact_type=eq.${encodeURIComponent(impactType)}`;
    if (postId)    q += `&post_id=eq.${encodeURIComponent(postId)}`;
    if (commentId) q += `&comment_id=eq.${encodeURIComponent(commentId)}`;
    const del = await sbFetch(q, { method: 'DELETE' });
    return del.ok;
}

export async function countImpactsGivenByUser({ userId, sinceIso }) {
    // PostgREST count via Prefer: count=exact + HEAD-style; we do a cheap
    // SELECT id and array length for simplicity / portability.
    const { ok, data } = await sbFetch(
        `nexus_impacts?user_id=eq.${encodeURIComponent(userId)}` +
        `&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`
    );
    return (ok && Array.isArray(data)) ? data.length : 0;
}

export async function countImpactsReceivedByUser({ userId, sinceIso }) {
    // Two queries: posts authored by user, then impacts on those posts.
    // For volume we have today this is fine; swap to a SQL view later.
    const posts = await sbFetch(
        `nexus_posts?author_user_id=eq.${encodeURIComponent(userId)}` +
        `&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,impact_count`
    );
    if (!posts.ok || !Array.isArray(posts.data)) return 0;
    return posts.data.reduce((sum, p) => sum + (p.impact_count || 0), 0);
}

// — Trend signals —
export async function insertTrendSignal({ themeKey, themeLabel, evidence, weight = 1.0 }) {
    const ins = await sbFetch('nexus_trend_signals', {
        method: 'POST',
        body:   { theme_key: themeKey, theme_label: themeLabel, evidence, weight },
        prefer: 'return=representation',
    });
    return ins.ok;
}

export async function listRecentTrendSignals({ sinceIso, limit = 1000 }) {
    const { ok, data } = await sbFetch(
        `nexus_trend_signals?observed_at=gte.${encodeURIComponent(sinceIso)}` +
        `&order=observed_at.desc&limit=${limit}&select=*`
    );
    return (ok && Array.isArray(data)) ? data : [];
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
