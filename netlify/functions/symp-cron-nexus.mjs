// Hourly Nexus CRON — runs the three Omnipresent-AI maintenance loops:
//
//   1. Zero-engagement reply sweep    (every hour)
//   2. TL;DR backfill                 (every hour)
//   3. TrendAnalyzer pop-up spawner   (every 6 hours; cheap to gate by clock)
//
// Same idempotency story as the action-loop CRON: handlers are individually
// idempotent (zero-engagement bails on ai_replied_at, TL;DR bails on
// existing ai_tldr, trend skips themes that already have a live community),
// so a double-fire is harmless.

import { sweepZeroEngagement, sweepTldrBackfill } from '../../symp-core/lib/nexus/ai-participant.mjs';
import { runTrendSweep } from '../../symp-core/lib/nexus/trend-analyzer.mjs';

export default async (_req) => {
    const t0 = Date.now();
    const hour = new Date().getUTCHours();
    // Run the trend sweep at 0/6/12/18 UTC. The hourly granularity keeps it
    // cheap; deeper analysis cadence isn't needed because signal volume is
    // bursty and we already have a 24h rolling window.
    const runTrend = (hour % 6) === 0;

    try {
        const [zero, tldr, trend] = await Promise.all([
            sweepZeroEngagement({ batch: 25 }).catch(e => ({ error: e.message })),
            sweepTldrBackfill({ batch: 15 }).catch(e => ({ error: e.message })),
            runTrend
                ? runTrendSweep({ windowHours: 24 }).catch(e => ({ error: e.message }))
                : Promise.resolve({ skipped: true, reason: 'gated-to-6h' }),
        ]);
        const report = { zero, tldr, trend };
        console.log(`[cron/nexus] ok ${Date.now() - t0}ms`, JSON.stringify(report));
        return new Response(JSON.stringify({ ok: true, report }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        console.error(`[cron/nexus] failed ${Date.now() - t0}ms`, e.message);
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const config = {
    schedule: '0 * * * *',
};
