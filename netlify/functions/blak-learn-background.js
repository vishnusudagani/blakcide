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
    const { user_id, userText, assistantText } = body || {};
    if (!user_id || !userText) return { statusCode: 200, body: 'noop' };

    // No time pressure here — background functions get up to 15 minutes.
    try {
        const { extractKnowledge } = await import('../../symp-core/lib/knowledge-extractor.mjs');
        await extractKnowledge(user_id, { userText, assistantText });
    } catch (e) { console.warn('[learn-bg] extract failed:', e && e.message); }

    try {
        const { updateRollingMemory } = await import('../../symp-core/lib/memory-updater.mjs');
        await updateRollingMemory(user_id, { userText, assistantText });
    } catch (e) { console.warn('[learn-bg] memory failed:', e && e.message); }

    return { statusCode: 200, body: 'done' };
};
