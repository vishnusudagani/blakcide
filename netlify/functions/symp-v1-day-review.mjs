// POST /api/symp/v1/day-review — a "day in review" for the profile calendar.
//
// Two modes (user_id is injected by the proxy from the JWT):
//   { month: 'YYYY-MM', tzo? }  → { dates: ['YYYY-MM-DD', …] }  (which days have
//                                  saved activity → dots on the calendar)
//   { date:  'YYYY-MM-DD', tzo? } → { summary, empty, counts }  (a warm recap of
//                                  everything Blaksyd saved that day)
//
// Pulls across the pillars the app saves: Blak chats, mood logs, journals, the
// learning-loop's nightly day summaries/analyses, Minit events, Nexus activity.
// `tzo` is the browser's getTimezoneOffset() (minutes) so a day is the USER's
// local day, not a UTC day. Reads use the service role (RLS-bypassing) but are
// always scoped to the authenticated user_id.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sbGet(path) {
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        });
        if (!r.ok) return [];
        return await r.json().catch(() => []);
    } catch (e) { return []; }
}

// Map a UTC ISO timestamp to the user's LOCAL calendar date (YYYY-MM-DD).
function localDateOf(iso, tzo) {
    const ms = new Date(iso).getTime() - tzo * 60000;     // local = UTC - tzo
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
// The UTC window [start, end) that corresponds to a local day/range.
function utcWindow(localDateStr, days, tzo) {
    const start = Date.parse(localDateStr + 'T00:00:00Z') + tzo * 60000;   // UTC = local + tzo
    return [new Date(start).toISOString(), new Date(start + days * 86400000).toISOString()];
}
const isDate  = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = (s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);
    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const { user_id, date, month } = parsed.data || {};
    const tzo = Number.isFinite(parsed.data?.tzo) ? Math.max(-840, Math.min(840, parsed.data.tzo)) : 0;
    if (!user_id || !SUPABASE_URL || !SERVICE_KEY) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Not available', 400, requestId);
    }
    const ok = (data) => new Response(
        JSON.stringify({ ok: true, data, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );
    const enc = encodeURIComponent;

    // The user's Blak chat ids (needed because `messages` is keyed by chat).
    const chatIds = async () => {
        const rows = await sbGet(`chats?user_id=eq.${user_id}&select=id&limit=300`);
        return Array.isArray(rows) ? rows.map((r) => r.id) : [];
    };

    try {
        // ── MONTH MODE: which local days had any saved activity ───────────────
        if (isMonth(month)) {
            const first = month + '-01';
            const [winA, winB] = utcWindow(first, 31, tzo);   // 31 covers any month length
            const ids = await chatIds();
            const idFilter = ids.length ? `&chat_id=in.(${ids.join(',')})` : '';

            const [msgs, moods, minit, nexus, djs, das, sess, jrnl] = await Promise.all([
                ids.length ? sbGet(`messages?select=created_at${idFilter}&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&limit=2000`) : [],
                sbGet(`mood_logs?user_id=eq.${user_id}&select=created_at&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&limit=1000`),
                sbGet(`minit_events?user_id=eq.${user_id}&select=created_at&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&limit=1000`),
                sbGet(`nexus_impacts?user_id=eq.${user_id}&select=created_at&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&limit=1000`),
                sbGet(`symp_daily_journals?user_id=eq.${user_id}&select=journal_date&journal_date=gte.${first}&journal_date=lt.${month}-32&limit=40`),
                sbGet(`symp_daily_analyses?user_id=eq.${user_id}&select=analysis_date&analysis_date=gte.${first}&analysis_date=lt.${month}-32&limit=40`),
                sbGet(`symp_session_summaries?user_id=eq.${user_id}&select=summary_date&summary_date=gte.${first}&summary_date=lt.${month}-32&limit=200`),
                sbGet(`journal_entries?user_id=eq.${user_id}&select=entry_date,created_at&limit=400`),
            ]);

            const set = new Set();
            for (const r of msgs)  if (r.created_at) set.add(localDateOf(r.created_at, tzo));
            for (const r of moods) if (r.created_at) set.add(localDateOf(r.created_at, tzo));
            for (const r of minit) if (r.created_at) set.add(localDateOf(r.created_at, tzo));
            for (const r of nexus) if (r.created_at) set.add(localDateOf(r.created_at, tzo));
            for (const r of djs)   if (isDate(r.journal_date))  set.add(r.journal_date);
            for (const r of das)   if (isDate(r.analysis_date)) set.add(r.analysis_date);
            for (const r of sess)  if (isDate(r.summary_date))  set.add(r.summary_date);
            for (const r of jrnl)  { const d = isDate(r.entry_date) ? r.entry_date : (r.created_at ? localDateOf(r.created_at, tzo) : null); if (d) set.add(d); }

            const dates = [...set].filter((d) => d.startsWith(month)).sort();
            logAccess({ requestId, endpoint: 'day-review', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
            return ok({ dates });
        }

        // ── DAY MODE: gather + summarize one local day ────────────────────────
        if (!isDate(date)) return jsonError(ERROR_CODES.BAD_REQUEST, 'date (YYYY-MM-DD) or month (YYYY-MM) required', 400, requestId);
        const [winA, winB] = utcWindow(date, 1, tzo);
        const ids = await chatIds();
        const idFilter = ids.length ? `&chat_id=in.(${ids.join(',')})` : '';

        const [msgs, moods, minit, nexus, djs, das, sess, jrnl] = await Promise.all([
            ids.length ? sbGet(`messages?select=role,content,media_type,media_description,created_at${idFilter}&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&order=created_at.asc&limit=60`) : [],
            sbGet(`mood_logs?user_id=eq.${user_id}&select=mood,created_at&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&order=created_at.asc&limit=40`),
            sbGet(`minit_events?user_id=eq.${user_id}&select=event,created_at&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&limit=40`),
            sbGet(`nexus_impacts?user_id=eq.${user_id}&select=impact_type&created_at=gte.${enc(winA)}&created_at=lt.${enc(winB)}&limit=60`),
            sbGet(`symp_daily_journals?user_id=eq.${user_id}&select=summary_content,entry_type&journal_date=eq.${date}&limit=4`),
            sbGet(`symp_daily_analyses?user_id=eq.${user_id}&select=psychology,key_themes&analysis_date=eq.${date}&limit=1`),
            sbGet(`symp_session_summaries?user_id=eq.${user_id}&select=source,content&summary_date=eq.${date}&limit=10`),
            sbGet(`journal_entries?user_id=eq.${user_id}&select=title,emotion,content,entry_date,created_at&entry_date=eq.${date}&limit=20`),
        ]);

        const counts = {
            chats: msgs.length, moods: moods.length, journals: jrnl.length,
            minit: minit.length, nexus: nexus.length,
        };
        const hasAnything = msgs.length || moods.length || jrnl.length || minit.length || nexus.length
            || djs.length || (das && das.length) || sess.length;
        if (!hasAnything) {
            logAccess({ requestId, endpoint: 'day-review', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
            return ok({ summary: null, empty: true, counts });
        }

        // Build a compact context blob for the model.
        const parts = [];
        if (das && das[0]) {
            if (Array.isArray(das[0].key_themes) && das[0].key_themes.length) parts.push('Themes of the day: ' + das[0].key_themes.join(', '));
            if (das[0].psychology) parts.push('Reflection on the day: ' + String(das[0].psychology).slice(0, 500));
        }
        for (const d of djs) if (d.summary_content) parts.push('Day note: ' + String(d.summary_content).slice(0, 400));
        for (const s of sess) if (s.content) parts.push(`${s.source || 'Session'} summary: ` + String(s.content).slice(0, 300));
        if (moods.length) parts.push('Moods logged: ' + moods.map((m) => m.mood).filter(Boolean).join(', '));
        for (const j of jrnl) {
            const bits = [j.title, j.emotion ? `(felt ${j.emotion})` : '', j.content ? '— ' + String(j.content).slice(0, 160) : ''].filter(Boolean).join(' ');
            if (bits) parts.push('Journal: ' + bits);
        }
        if (minit.length) parts.push(`Minit (human listener) activity: ${minit.length} event(s)`);
        if (nexus.length) parts.push(`Nexus community activity: ${nexus.length} interaction(s)`);
        if (msgs.length) {
            const snip = msgs
                .map((m) => {
                    let c = String(m.content || '').trim();
                    if (!c && m.media_type === 'audio') c = m.media_description ? `[voice note: ${m.media_description}]` : '[voice note]';
                    else if (!c && m.media_type === 'call') c = '[on a call]';
                    else if (!c && m.media_description) c = `[image: ${m.media_description}]`;
                    return c ? `${m.role === 'user' ? 'You' : 'Blak'}: ${c.slice(0, 220)}` : '';
                })
                .filter(Boolean).slice(0, 24).join('\n');
            if (snip) parts.push('Chats with Blak:\n' + snip);
        }
        const context = parts.join('\n\n').slice(0, 6000);

        const SYS = [
            'You are Blak, gently recapping your friend\'s day back to them from what Blaksyd quietly saved.',
            'Write a warm, second-person "day in review" — like a friend who was there. Start with one sentence on the shape of the day, then up to 4 short "• " lines for the notable bits (a mood, a conversation, a journal, time with a listener, community).',
            'Be concrete and kind, ≤110 words, in the SAME language the user used. Reference real moods/topics from the notes. Never invent anything not in the notes. No clinical/therapy language, no headings, no "Summary:" prefix, no sign-off.',
        ].join('\n');

        let summary = '';
        try {
            const out = await chatCompleteFailover([
                { role: 'system', content: SYS },
                { role: 'user',   content: `Date: ${date}\n\nWhat Blaksyd saved:\n${context}\n\nRecap my day.` },
            ], { temperature: 0.55, maxTokens: 320, timeoutMs: 18000, tier: 'quality' });
            summary = (out.text || '').trim();
        } catch (e) {
            return jsonError(ERROR_CODES.UPSTREAM_ERROR || 'UPSTREAM_ERROR', 'Could not build your day right now', 502, requestId);
        }

        logAccess({ requestId, endpoint: 'day-review', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return ok({ summary, empty: false, counts });
    } catch (e) {
        return jsonError(ERROR_CODES.UPSTREAM_ERROR || 'UPSTREAM_ERROR', 'Day review failed', 502, requestId);
    }
};

export const config = { path: '/api/symp/v1/day-review' };
