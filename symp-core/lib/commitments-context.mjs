// Commitments context — what Blak is actively holding FOR the user, so it can
// reference and gently manage them like a real assistant-friend: upcoming
// reminders the user set, plus things Blak promised to follow up on (the
// "followthrough" nudges scheduled by the proactive engine).
//
// Times are rendered RELATIVE ("in ~2h", "in 3 days") so we never need the user's
// timezone. Self-contained service-role reads — no edits to shared modules.
// Returns '' when there's nothing pending.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sbGet(path) {
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
        return r.ok ? await r.json().catch(() => []) : [];
    } catch (_) { return []; }
}

function rel(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    const past = ms < 0, a = Math.abs(ms);
    const m = Math.round(a / 60000), h = Math.round(a / 3600000), d = Math.round(a / 86400000);
    let s;
    if (m < 1) return 'right now';
    else if (m < 60) s = `${m} min`;
    else if (h < 24) s = `~${h}h`;
    else if (d < 14) s = `${d} day${d === 1 ? '' : 's'}`;
    else s = `~${Math.round(d / 7)} weeks`;
    return past ? `${s} ago` : `in ${s}`;
}

export async function buildCommitmentsBlock(userId) {
    if (!userId || !SUPABASE_URL || !SERVICE_KEY) return '';
    const now = Date.now();
    const floor = encodeURIComponent(new Date(now - 60 * 60 * 1000).toISOString());   // include just-passed (last 1h)
    const horizon = encodeURIComponent(new Date(now + 30 * 86400000).toISOString());  // next 30 days
    const [reminders, followups] = await Promise.all([
        sbGet(`blak_reminders?user_id=eq.${userId}&done=eq.false&remind_at=gte.${floor}&remind_at=lte.${horizon}&select=text,remind_at&order=remind_at.asc&limit=6`),
        sbGet(`blak_nudges?user_id=eq.${userId}&kind=eq.followthrough&due_at=gte.${floor}&due_at=lte.${horizon}&select=text,due_at&order=due_at.asc&limit=4`),
    ]);
    const lines = [];
    for (const r of (reminders || [])) if (r && r.text) lines.push(`- reminder: ${String(r.text).slice(0, 160)} (${rel(r.remind_at)})`);
    for (const f of (followups || [])) if (f && f.text) lines.push(`- you said you'd check in: ${String(f.text).slice(0, 160)} (${rel(f.due_at)})`);
    if (!lines.length) return '';
    return [
        "=== WHAT YOU'RE HOLDING FOR THEM ===",
        "Reminders this person set and things you (Blak) promised to follow up on. You KNOW these. Bring one up naturally ONLY when it genuinely fits — it's coming up very soon, or they mention something related — like a friend who remembers, never a nagging checklist. Don't recite the list unprompted. If they ask what's coming up, you can run through it warmly.",
        ...lines,
        '=== END ===',
    ].join('\n');
}
