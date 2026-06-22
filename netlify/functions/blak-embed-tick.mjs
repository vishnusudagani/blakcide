// Embedding heartbeat — embeds un-embedded chat messages so Blak can recall past
// conversations by meaning (semantic recall). Backfills history and keeps up with
// new messages. Cheap (one batched embedding call + PATCHes); no chat-path latency.
// Netlify scheduled functions run ONLY on the production deploy.

const PER_RUN = parseInt(process.env.EMBED_PER_RUN || '120', 10);

export default async () => {
    try {
        const { embedPendingMessages } = await import('../../symp-core/lib/recall.mjs');
        const embedded = await embedPendingMessages(PER_RUN);
        return new Response(JSON.stringify({ ok: true, embedded }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
};

export const config = { schedule: '*/10 * * * *' };
