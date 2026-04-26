// Hourly CRON — runs the proactive Action Loop.
//
// Netlify Scheduled Function: invoked by the platform on the cron schedule
// declared in `config` below. No Authorization header is provided; that's
// fine because we import the runner directly rather than going over HTTP.
//
// Hourly cadence is the right grain:
//   - Triggers are evaluated against IST quiet hours (08:00–22:00)
//   - Idempotency is enforced at the DB layer (partial unique index on
//     symp_action_loop), so accidental double-fires within an hour collapse
//   - Lower cadence (e.g., per-15-min) wastes Supabase reads for almost no
//     UX improvement; higher (daily) misses the "user disengaged this
//     afternoon" window
//
// Output is logged for Netlify's CRON dashboard.

import { runOnce } from '../../symp-core/lib/action-loop.mjs';

export default async (_req) => {
    const t0 = Date.now();
    try {
        const report = await runOnce({ limit: 500 });
        console.log(`[cron/action-loop] ok ${Date.now() - t0}ms`, JSON.stringify(report));
        return new Response(JSON.stringify({ ok: true, report }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        console.error(`[cron/action-loop] failed ${Date.now() - t0}ms`, e.message);
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

// Hourly. Adjust here if user feedback shows we're nudging too often or too
// rarely; the trigger logic itself stays the same.
export const config = {
    schedule: '0 * * * *',
};
