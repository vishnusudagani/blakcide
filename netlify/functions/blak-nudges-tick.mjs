// Hourly scheduled function — Blak's proactive heartbeat.
//
// For each recently-active user, the proactive brain decides a timely check-in /
// morning-evening beat / gentle silence-nudge / win celebration, respecting that
// user's frequency level (none|low|default|high) + cooldown + daily cap. Stores
// pending nudges that the app surfaces on the home screen (and push/WhatsApp
// later). Per-turn "follow-through" nudges are scheduled elsewhere (the learner).
//
// Netlify scheduled functions run ONLY on the production deploy.

const PER_RUN = parseInt(process.env.NUDGES_PER_RUN || '60', 10);   // bound cost per tick

export default async () => {
    try {
        const { activeUserIds, maybeGenerateNudge } = await import('../../symp-core/lib/proactive.mjs');
        const users = await activeUserIds(14, PER_RUN);
        let made = 0;
        for (const uid of users) {
            try { const n = await maybeGenerateNudge(uid); if (n) made++; } catch (_) { /* per-user best-effort */ }
        }
        return new Response(JSON.stringify({ ok: true, considered: users.length, nudged: made }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
};

export const config = { schedule: '@hourly' };
