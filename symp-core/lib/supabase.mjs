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
