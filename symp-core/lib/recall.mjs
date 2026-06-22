// Semantic recall — lets Blak surface relevant PAST conversations by meaning,
// not just the current thread ("oh yeah, you mentioned your Goa trip"). Two halves:
//
//   embedPendingMessages(limit)  — cron: embed un-embedded chat messages (also
//        backfills history) with text-embedding-3-small (1536d). For image-only
//        messages it embeds the vision caption (media_description) so photos are
//        recallable too.
//   buildRecallBlock(userId, latestUserText, currentChatId) — per chat turn:
//        embed the latest message, fetch top-similar PAST messages via the
//        match_user_messages RPC, render a compact context block (or '' if none
//        close enough).
//
// Self-contained service-role REST (no shared-module edits). Degrades to a no-op
// if embeddings/keys aren't configured.

import { embed } from './inference.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const MIN_LEN   = 12;     // ignore trivial text ("ok", "lol") at recall time
const SIM_FLOOR = 0.34;   // cosine floor for "actually related" (3-small)

async function sb(path, opts = {}) {
    const { method = 'GET', body, prefer } = opts;
    const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        if (!r.ok) return { ok: false, status: r.status, data: null };
        const txt = await r.text();
        return { ok: true, status: r.status, data: txt ? JSON.parse(txt) : null };
    } catch (e) { return { ok: false, status: 0, data: null }; }
}

async function embedOne(text) {
    const out = await embed({ input: String(text).slice(0, 4000), dimensions: 1536 });
    const v = out && out.embedding;
    return Array.isArray(v) && Array.isArray(v[0]) ? v[0] : v;   // single vector
}

// Cron: embed a batch of un-embedded messages (newest first). Returns count.
export async function embedPendingMessages(limit = 120) {
    if (!SUPABASE_URL || !SERVICE_KEY) return 0;
    const cap = Math.min(Math.max(1, limit), 200);
    const sel = await sb(`messages?embedding=is.null&select=id,content,media_description&order=created_at.desc&limit=${cap}`);
    if (!sel.ok || !Array.isArray(sel.data) || !sel.data.length) return 0;
    // Embed substantive text or, for image-only rows, the vision caption.
    const rows = [];
    for (const m of sel.data) {
        const text = ((m.content || '').trim() || (m.media_description || '').trim());
        if (text) rows.push({ id: m.id, text: text.slice(0, 4000) });
    }
    if (!rows.length) return 0;
    let vecs;
    try { const out = await embed({ input: rows.map((r) => r.text), dimensions: 1536 }); vecs = out && out.embedding; }
    catch (e) { return 0; }
    if (!Array.isArray(vecs) || !Array.isArray(vecs[0])) return 0;
    // PATCH in bounded-concurrency chunks so a 120-row backfill run stays fast.
    let n = 0;
    const CHUNK = 12;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const results = await Promise.all(slice.map((row, j) => {
            const vec = vecs[i + j];
            if (!Array.isArray(vec)) return Promise.resolve(false);
            return sb(`messages?id=eq.${row.id}`, { method: 'PATCH', body: { embedding: vec }, prefer: 'return=minimal' }).then((r) => r.ok);
        }));
        n += results.filter(Boolean).length;
    }
    return n;
}

// Per chat turn: relevant snippets from past conversations, or '' if nothing close.
export async function buildRecallBlock(userId, latestUserText) {
    if (!userId || !SUPABASE_URL || !SERVICE_KEY) return '';
    const q = String(latestUserText || '').trim();
    if (q.length < MIN_LEN) return '';     // skip trivial / greeting turns
    let vec;
    try { vec = await embedOne(q); } catch (e) { return ''; }
    if (!Array.isArray(vec)) return '';
    // Exclude the active session (last 2h) so we recall OLDER threads, not echo the current one.
    const before = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const res = await sb('rpc/match_user_messages', { method: 'POST', body: { p_user_id: userId, p_query: vec, p_limit: 8, p_before: before } });
    if (!res.ok || !Array.isArray(res.data)) return '';
    const seen = new Set(); const picks = [];
    for (const r of res.data) {
        if (!r || typeof r.similarity !== 'number' || r.similarity < SIM_FLOOR) continue;
        const c = (r.content || '').trim();
        if (c.length < MIN_LEN) continue;
        const key = c.slice(0, 40).toLowerCase();
        if (seen.has(key)) continue; seen.add(key);
        picks.push(r);
        if (picks.length >= 4) break;
    }
    if (!picks.length) return '';
    const lines = picks.map((r) => `- ${r.role === 'user' ? 'They said' : 'You said'}: "${(r.content || '').slice(0, 200)}"${r.chat_title ? ` (from "${r.chat_title}")` : ''}`);
    return [
        '=== YOU REMEMBER TALKING ABOUT THIS ===',
        'Snippets from your PAST conversations with this person that seem related to what they just said. Use them like a friend who remembers — a light "oh yeah, you mentioned…" — ONLY if genuinely relevant. Never force it, never list them back, never say you searched or quote them verbatim. If they don\'t actually fit, ignore them.',
        ...lines,
        '=== END ===',
    ].join('\n');
}
