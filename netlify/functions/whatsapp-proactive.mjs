// Scheduled — Blak's proactive "real friend" check-ins on WhatsApp.
//
// Runs hourly. For each active WhatsApp user whose 24h customer-service window is
// still OPEN (so the message is FREE — no paid template) and who hasn't been pinged
// recently, Blak DECIDES whether to send ONE short, natural check-in in their
// language — or stay quiet (SKIP). Honors quiet hours + a per-user cooldown.
// Anti-engagement-bait by design: only inside the free window, only when genuine.

import { sendText, persistMessage, loadThreadHistory } from '../../symp-core/lib/whatsapp.mjs';
import { buildChatSystemStack } from '../../symp-core/lib/system-prompt.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Quiet hours in UTC (defaults ≈ 09:30–21:30 IST — the India-first audience).
const START_H    = Number(process.env.PROACTIVE_START_HOUR_UTC ?? 4);
const END_H      = Number(process.env.PROACTIVE_END_HOUR_UTC ?? 16);
const COOLDOWN_H = Number(process.env.PROACTIVE_COOLDOWN_HOURS ?? 20);   // ~1/day
const MAX_PER_RUN = Number(process.env.PROACTIVE_MAX_PER_RUN ?? 25);

async function sb(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: opts.method || 'GET',
        headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json', ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (_) { d = t; }
    return { ok: res.ok, data: d };
}

const PROACTIVE_PROMPT = {
    role: 'system',
    content: [
        'PROACTIVE CHECK-IN: the user has not messaged in a little while. You may reach out FIRST, like a real friend — but ONLY if it feels genuine.',
        'If there is something real worth saying — following up on something they told you, or a warm casual check-in fitting the time of day ("had lunch?", "how did <thing> go?", "still on for tonight?") — write ONE short, natural message in THEIR usual language. No greeting boilerplate, no "just checking in", no clichés.',
        'If there is nothing genuine to say, reply with EXACTLY one word: SKIP',
        'Never salesy, never guilt-trippy, never spam. One short line.',
    ].join('\n'),
};

async function nudgeFor(userId, chatId) {
    const history = await loadThreadHistory(chatId, 12);
    if (!history.length) return null;
    let stack = [];
    try { stack = await buildChatSystemStack(userId, { latestUserText: '' }); } catch (_) { /* soft */ }
    const messages = [...stack, PROACTIVE_PROMPT, ...history];
    try {
        const { text } = await chatCompleteFailover(messages, { tier: 'quality', maxTokens: 200, temperature: 0.9, timeoutMs: 20000 });
        const t = (text || '').trim();
        return (!t || /^skip\.?$/i.test(t)) ? null : t;
    } catch (_) { return null; }
}

export default async () => {
    const h = new Date().getUTCHours();
    if (h < START_H || h >= END_H) return new Response('quiet-hours', { status: 200 });

    const dayAgo  = new Date(Date.now() - 24 * 3600_000).toISOString();
    const coolAgo = new Date(Date.now() - COOLDOWN_H * 3600_000).toISOString();
    // Window OPEN (inbound within 24h) AND not pinged within the cooldown.
    const q = `wa_identities?status=eq.active&last_inbound_at=gte.${dayAgo}`
            + `&or=(last_proactive_at.is.null,last_proactive_at.lt.${coolAgo})`
            + `&select=phone,user_id,chat_id&limit=${MAX_PER_RUN}`;
    const { ok, data } = await sb(q);
    if (!ok || !Array.isArray(data) || !data.length) return new Response('no-candidates', { status: 200 });

    let sent = 0;
    for (const row of data) {
        if (!row.chat_id) continue;
        const text = await nudgeFor(row.user_id, row.chat_id);
        if (!text) continue;
        try {
            await sendText(row.phone, text);
            await persistMessage({ chatId: row.chat_id, role: 'ai', content: text });
            await sb(`wa_identities?phone=eq.${encodeURIComponent(row.phone)}`, {
                method: 'PATCH', prefer: 'return=minimal', body: { last_proactive_at: new Date().toISOString() },
            });
            sent++;
        } catch (e) { console.error('[wa-proactive] send failed', row.phone, e?.message || e); }
    }
    return new Response(`proactive sent=${sent}/${data.length}`, { status: 200 });
};

// Netlify scheduled function — hourly. Each run pings at most the daily-eligible set.
export const config = { schedule: '0 * * * *' };
