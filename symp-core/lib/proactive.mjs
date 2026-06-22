// Proactive Blak — the brain that decides when Blak reaches out, and stores the
// nudge for the app (and later push/WhatsApp) to surface.
//
// Two entry points:
//   scheduleFollowThrough(userId, userText, assistantText)
//       Fired per chat turn (from blak-learn-background). If Blak promised to
//       check in, or the user mentioned a clear upcoming thing, it schedules a
//       future "followthrough" nudge. Auto-detected + silent (no confirm).
//   maybeGenerateNudge(userId)
//       Fired by the hourly cron for active users. Decides a timely check-in /
//       morning-evening beat / gentle silence-nudge / win celebration, or skips.
//
// All writes use the service role but are always scoped to user_id. Per-user
// frequency is gated by blak_prefs.proactivity (none|low|default|high).

import { chatCompleteFailover } from './llm-providers.mjs';
import { sendWebPush, webPushConfigured } from './webpush.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// How many nudges Blak may CREATE per user per day, by level.
export const LEVEL_CAP = { none: 0, low: 1, default: 4, high: 8 };
const MIN_GAP_MS = 3 * 3600 * 1000;     // ≥3h between Blak-initiated nudges

async function sbGet(path) {
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
        return r.ok ? await r.json().catch(() => []) : [];
    } catch (e) { return []; }
}
async function sbInsert(table, body) {
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: 'POST',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify(body),
        });
        return r.ok ? await r.json().catch(() => null) : null;
    } catch (e) { return null; }
}
async function sbPatch(path, body) {
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify(body),
        });
        return r.ok;
    } catch (e) { return false; }
}
async function sbDelete(path) {
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
        return r.ok;
    } catch (e) { return false; }
}

function parseJson(raw) {
    if (!raw) return null;
    let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j < i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
}

export async function getProactivityLevel(userId) {
    const rows = await sbGet(`blak_prefs?user_id=eq.${userId}&select=proactivity,last_nudge_at&limit=1`);
    const r = Array.isArray(rows) && rows[0];
    return { level: (r && r.proactivity) || 'default', lastNudgeAt: r && r.last_nudge_at };
}

async function dailyCount(userId) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = await sbGet(`blak_nudges?user_id=eq.${userId}&created_at=gte.${encodeURIComponent(since)}&select=id`);
    return Array.isArray(rows) ? rows.length : 0;
}

async function noteNudge(userId, nudge) {
    await sbInsert('blak_nudges', { user_id: userId, ...nudge });
    // upsert last_nudge_at on prefs
    await fetch(`${SUPABASE_URL}/rest/v1/blak_prefs?on_conflict=user_id`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: userId, last_nudge_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    }).catch(() => {});
}

const FT_SYS = [
    'You decide if Blak (a warm AI friend) should PROACTIVELY check in LATER about this exchange — like a real friend who remembers.',
    'Say yes ONLY if there is a concrete future thing to follow up on: the user mentioned an upcoming event (interview, exam, date, appointment, trip, deadline) OR Blak said it would check in.',
    'If yes: write the short, warm line Blak will send THEN (reference the thing, e.g. "hey — how did the interview go? 🤞"), and estimate hours from now until just AFTER it (tomorrow ≈ 20–28h; "tonight" ≈ 5h; "next week" ≈ 168h).',
    'If there is nothing concrete to follow up on, say no. Do not invent. Be selective — most turns are "no".',
    'OUTPUT strict JSON only: {"nudge": true|false, "text": "", "hours": 0}',
].join('\n');

export async function scheduleFollowThrough(userId, userText, assistantText) {
    if (!userId || !userText || !SUPABASE_URL || !SERVICE_KEY) return;
    try {
        const { level } = await getProactivityLevel(userId);
        if (level === 'none') return;
        const out = await chatCompleteFailover([
            { role: 'system', content: FT_SYS },
            { role: 'user', content: `User: ${String(userText).slice(0, 800)}\nBlak: ${String(assistantText || '').slice(0, 800)}\n\nDecide now.` },
        ], { temperature: 0.2, maxTokens: 160, timeoutMs: 12000, tier: 'cheap' });
        const j = parseJson(out.text);
        if (!j || !j.nudge || !j.text) return;
        let hours = Number(j.hours); if (!Number.isFinite(hours)) hours = 24;
        hours = Math.max(1, Math.min(720, hours));
        const due = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        await sbInsert('blak_nudges', { user_id: userId, kind: 'followthrough', text: String(j.text).slice(0, 400), due_at: due });
    } catch (e) { /* best-effort */ }
}

const NUDGE_SYS = [
    'You are Blak deciding whether to message your friend RIGHT NOW, unprompted — like a real friend, never a notification bot.',
    'Reach out only if there is a GENUINE warm reason: something they were up to that you can ask about, they have been quiet a while and a gentle "thinking of you" fits, a logged win worth celebrating, or a natural morning/evening check-in. If nothing real, SKIP — silence is fine.',
    'When you do: ONE short, warm, casual line in THEIR language, like a text from a friend (use their name/what you know). No pep-talk clichés, no pressure.',
    'OUTPUT strict JSON only: {"nudge": true|false, "kind": "checkin|morning|evening|silence|win", "text": ""}',
].join('\n');

// Decide + store a fresh nudge for one active user. Returns the nudge or null.
export async function maybeGenerateNudge(userId) {
    if (!userId || !SUPABASE_URL || !SERVICE_KEY) return null;
    try {
        const { level, lastNudgeAt } = await getProactivityLevel(userId);
        const cap = LEVEL_CAP[level] ?? LEVEL_CAP.default;
        if (cap <= 0) return null;
        if (lastNudgeAt && (Date.now() - new Date(lastNudgeAt).getTime()) < MIN_GAP_MS) return null;
        if (await dailyCount(userId) >= cap) return null;

        // Recent context: last messages from the user's web chats + a few facts.
        const chats = await sbGet(`chats?user_id=eq.${userId}&select=id&order=created_at.desc&limit=20`);
        const ids = (chats || []).map(c => c.id);
        let recent = [];
        let lastMsgAt = null;
        if (ids.length) {
            recent = await sbGet(`messages?chat_id=in.(${ids.join(',')})&select=role,content,created_at&order=created_at.desc&limit=8`);
            lastMsgAt = recent[0] && recent[0].created_at;
        }
        const facts = await sbGet(`symp_knowledge_facts?user_id=eq.${userId}&select=value&order=updated_at.desc&limit=8`);
        const hoursQuiet = lastMsgAt ? Math.round((Date.now() - new Date(lastMsgAt).getTime()) / 3600000) : 999;
        const transcript = (recent || []).slice().reverse()
            .map(m => `${m.role === 'user' ? 'Them' : 'Blak'}: ${String(m.content || '').slice(0, 160)}`).join('\n');
        const known = (facts || []).map(f => `- ${f.value}`).join('\n');

        const out = await chatCompleteFailover([
            { role: 'system', content: NUDGE_SYS },
            { role: 'user', content: `Hours since they last messaged: ${hoursQuiet}\n\nWhat you know about them:\n${known || '(not much yet)'}\n\nRecent chat:\n${transcript || '(none recently)'}\n\nShould you reach out now?` },
        ], { temperature: 0.6, maxTokens: 120, timeoutMs: 12000, tier: 'cheap' });
        const j = parseJson(out.text);
        if (!j || !j.nudge || !j.text) return null;
        const kind = ['checkin', 'morning', 'evening', 'silence', 'win'].includes(j.kind) ? j.kind : 'checkin';
        const nudge = { kind, text: String(j.text).slice(0, 400) };
        await noteNudge(userId, nudge);
        return nudge;
    } catch (e) { return null; }
}

// Deliver due, un-pushed nudges as web pushes (payloadless — the SW shows a warm
// generic line and tapping opens Blak, where the nudge already waits). Coalesces
// to one push per device per user, marks pushed_at, and prunes dead (404/410)
// subscriptions. A 12h window keeps a first-deploy backlog from blasting at once.
//   - immediate nudges (due_at NULL): pushed if created in the last 12h
//   - followthrough nudges (due_at set): pushed once due_at has passed (within 12h)
export async function pushDueNudges() {
    if (!SUPABASE_URL || !SERVICE_KEY || !webPushConfigured()) return 0;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const floorIso = new Date(now - 12 * 3600 * 1000).toISOString();
    const fl = encodeURIComponent(floorIso), nw = encodeURIComponent(nowIso);
    const sel = 'select=id,user_id&order=created_at.asc&limit=300';
    const [immediate, due] = await Promise.all([
        sbGet(`blak_nudges?pushed_at=is.null&due_at=is.null&created_at=gte.${fl}&${sel}`),
        sbGet(`blak_nudges?pushed_at=is.null&due_at=lte.${nw}&due_at=gte.${fl}&${sel}`),
    ]);
    const all = [...(immediate || []), ...(due || [])];
    if (!all.length) return 0;

    const byUser = new Map();
    for (const n of all) {
        if (!byUser.has(n.user_id)) byUser.set(n.user_id, []);
        byUser.get(n.user_id).push(n.id);
    }
    let sent = 0;
    for (const [uid, ids] of byUser) {
        const subs = await sbGet(`push_subscriptions?user_id=eq.${uid}&select=endpoint`);
        for (const s of (subs || [])) {
            const res = await sendWebPush(s);
            if (res.ok) sent++;
            else if (res.status === 404 || res.status === 410) await sbDelete(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`);
        }
        // Mark pushed regardless of whether a live device existed — avoids retry storms.
        await sbPatch(`blak_nudges?id=in.(${ids.join(',')})`, { pushed_at: nowIso });
    }
    return sent;
}

// Active users (web chat) in the last `days` days — for the cron to consider.
export async function activeUserIds(days = 14, limit = 400) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await sbGet(`messages?created_at=gte.${encodeURIComponent(since)}&sender_id=not.is.null&select=sender_id&limit=5000`);
    const set = new Set();
    for (const r of (rows || [])) if (r.sender_id) set.add(r.sender_id);
    return [...set].slice(0, limit);
}
