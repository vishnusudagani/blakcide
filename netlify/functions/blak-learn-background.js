// Background learning — runs Blak's post-turn fact extraction + rolling-memory
// update OFF the chat request path. Netlify Background Functions (the
// "-background" name suffix) return 202 immediately and may run up to 15 min, so
// a slow LLM / Groq failover is never cut off the way the inline awaited version
// was (facts were silently dropping). Fired by symp-v1-chat with a shared secret.
// CJS + dynamic import() because symp-core is ESM (same pattern as realtime-session.js).

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret   = event.headers['x-blak-secret'] || event.headers['X-Blak-Secret'] || '';
    const expected = process.env.SYMP_API_KEY || '';
    if (!expected || secret !== expected) return { statusCode: 403, body: 'Forbidden' };

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) { /* ignore */ }
    const { user_id, userText, assistantText, persona_id, persona_name, skip_global, threadId } = body || {};
    if (!user_id || !userText) return { statusCode: 200, body: 'noop' };

    // Fantasy persona: update the persona's OWN memory of this user — always, since
    // it's the character remembering you, independent of the global-profile toggle.
    if (persona_id) {
        try {
            const { updatePersonaMemory } = await import('../../symp-core/lib/persona-memory.mjs');
            await updatePersonaMemory(user_id, persona_id, persona_name, { userText, assistantText });
        } catch (e) { console.warn('[learn-bg] persona memory failed:', e && e.message); }
    }

    // Global profile learning (knowledge + rolling memory + follow-through) — skipped
    // when a persona's build_profile_from is off. No time pressure: bg gets ~15 min.
    if (!skip_global) {
        try {
            const { extractKnowledge } = await import('../../symp-core/lib/knowledge-extractor.mjs');
            // sourceKind/sourceRef give every learned fact its "why" provenance (#11/#12).
            await extractKnowledge(user_id, { userText, assistantText, sourceKind: 'chat', sourceRef: threadId || null });
        } catch (e) { console.warn('[learn-bg] extract failed:', e && e.message); }

        try {
            const { updateRollingMemory } = await import('../../symp-core/lib/memory-updater.mjs');
            await updateRollingMemory(user_id, { userText, assistantText });
        } catch (e) { console.warn('[learn-bg] memory failed:', e && e.message); }

        // Proactive follow-through: if Blak promised to check in (or the user has a
        // clear upcoming thing), silently schedule a future nudge. Auto-detected.
        try {
            const { scheduleFollowThrough } = await import('../../symp-core/lib/proactive.mjs');
            await scheduleFollowThrough(user_id, userText, assistantText);
        } catch (e) { console.warn('[learn-bg] followthrough failed:', e && e.message); }
    }

    return { statusCode: 200, body: 'done' };
};
