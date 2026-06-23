// Reminders heartbeat — fires user-set reminders as web pushes so "remind me at
// 6" actually alerts even when the app is closed. Runs every 5 minutes for decent
// timing precision; cheap (no LLM — just due-reminder delivery). Netlify scheduled
// functions run ONLY on the production deploy.

export default async () => {
    try {
        const { pushDueReminders } = await import('../../symp-core/lib/proactive.mjs');
        const pushed = await pushDueReminders();
        return new Response(JSON.stringify({ ok: true, pushed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
};

export const config = { schedule: '*/30 * * * *' }; // was */5 — reduced to cut Netlify scheduled-function spend (reminders may land up to ~30 min late)
