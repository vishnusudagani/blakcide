// Context engine v2 — turns the stored knowledge profile into the prompt block
// Blak actually carries. A compact CORE is always included; deeper facts are
// pulled in by relevance to the current message.
//
// v2 (part of the /beta/profile build-out) adds:
//   • visibility-aware: 'private' facts are never used; 'never_raise' facts are
//     surfaced to Blak ONLY as "know-but-don't-bring-up" (#16/#17)
//   • soft freshness: facts not re-seen in a while are flagged, not trusted blind (#6)
//   • first-class PEOPLE/PETS/PLACES from entities (#1) and COMING-UP dates from
//     events, incl. yearly birthdays/anniversaries (#2/#8/#36)
//   • a subtle, NON-CLINICAL recent-vibe cue from mood_logs (#21) — never a score
//
// Used by system-prompt.mjs for both chat (latest user message → per-turn
// relevance) and voice (no per-turn message → core + top facts).

import { fetchKnowledgeFacts, fetchEntities, fetchEvents, fetchRecentMoodSummary, fetchBlaksydProfile } from './supabase.mjs';
import { coreFields, missingFields, fieldMeta, isFresh, isUsableInContext, isShareable, ENTITY_KIND_META } from './knowledge-schema.mjs';

const STOP = new Set(
    ('the a an and or but to of in on for with my your you i me is are was were be been do does did this ' +
     'that have has had it its at as so if how what when who why not no yes just like really very about').split(' ')
);

// Soft, non-clinical phrasing for the recent-vibe cue. NEVER a diagnosis.
const MOOD_SOFT = { great: 'really good', okay: 'steady', low: 'a bit low', anxious: 'a bit on edge', angry: 'frustrated' };

function tokens(s) {
    return (String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(t => !STOP.has(t));
}

function coreKeySet() {
    return new Set(coreFields().map(f => `${f.area}:${f.key}`));
}

// User-edited / freshly-confirmed facts never read as stale on their own.
function freshTag(f) {
    if (f.status === 'user_edited' || f.last_confirmed_at) return '';
    return isFresh(f) ? '' : ' (noticed a while ago — may be outdated)';
}

function renderLine(f) {
    const label = f.label || (fieldMeta(f.area, f.key)?.label) || f.key;
    const hunch = (f.source === 'blak' && (f.confidence ?? 1) < 0.6) ? ' (hunch)' : '';
    return `- ${label}: ${String(f.value).slice(0, 160)}${hunch}${freshTag(f)}`;
}

function daysUntil(isoDate) {
    if (!isoDate) return null;
    const d = new Date(`${isoDate}T00:00:00`);
    if (isNaN(d.getTime())) return null;
    return Math.round((d.getTime() - Date.now()) / 86400000);
}

// Next upcoming occurrence of a yearly date (birthday / anniversary).
function nextYearly(isoDate) {
    if (!isoDate || isoDate.length < 10) return isoDate;
    const md = isoDate.slice(5); // MM-DD
    const year = new Date().getFullYear();
    let cand = `${year}-${md}`;
    if ((daysUntil(cand) ?? 0) < 0) cand = `${year + 1}-${md}`;
    return cand;
}

/**
 * Build the "what Blak knows" context block (or null if nothing's known yet).
 * @param {string} userId
 * @param {{latestUserText?:string, maxDetail?:number}} opts
 * @returns {Promise<string|null>}
 */
export async function buildKnowledgeBlock(userId, { latestUserText = '', maxDetail = 6 } = {}) {
    if (!userId) return null;

    let facts = [], entities = [], events = [], mood = null;
    try {
        [facts, entities, events, mood] = await Promise.all([
            fetchKnowledgeFacts(userId),
            fetchEntities(userId).catch(() => []),
            fetchEvents(userId).catch(() => []),
            fetchRecentMoodSummary(userId).catch(() => null),
        ]);
    } catch (_) { return null; }

    if (!facts.length && !entities.length && !events.length) {
        // Brand-new user: nudge Blak to actively (warmly) get to know them.
        return [
            '=== GETTING TO KNOW THEM ===',
            'You barely know this person yet. As you chat, actively but warmly get to know them — their name, where they are, what they do, who matters to them, what they like. When something opens a thread, ask ONE natural follow-up. Never interrogate.',
            '=== END ===',
        ].join('\n');
    }

    // Only facts Blak may use in conversation (exclude 'private' + archived).
    const usable = facts.filter(isUsableInContext);
    const neverRaise = usable.filter(f => f.never_raise);
    const open = usable.filter(f => !f.never_raise);

    const core = coreKeySet();
    const coreFactsArr = open.filter(f => core.has(`${f.area}:${f.key}`));
    let detail = open.filter(f => !core.has(`${f.area}:${f.key}`));

    if (latestUserText) {
        const q = new Set(tokens(latestUserText));
        detail = detail
            .map(f => {
                const ft = tokens(`${f.area} ${f.key} ${f.label || ''} ${f.value}`);
                let score = 0;
                for (const t of ft) if (q.has(t)) score++;
                return { f, score };
            })
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score || (b.f.confidence || 0) - (a.f.confidence || 0))
            .slice(0, maxDetail)
            .map(x => x.f);
    } else {
        detail = detail
            .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
            .slice(0, Math.max(maxDetail, 8));
    }

    const parts = ['=== WHAT BLAK KNOWS ABOUT THEM (their profile — weave in naturally, NEVER recite or read it back) ==='];
    if (coreFactsArr.length) {
        parts.push('CORE:');
        for (const f of coreFactsArr) parts.push(renderLine(f));
    }
    if (detail.length) {
        parts.push(latestUserText ? 'RELEVANT RIGHT NOW:' : 'MORE:');
        for (const f of detail) parts.push(renderLine(f));
    }

    // People / pets / places that matter (#1).
    const ents = entities.filter(e => e.visibility !== 'private' && !e.never_raise).slice(0, 8);
    if (ents.length) {
        parts.push('PEOPLE & THINGS THAT MATTER:');
        for (const e of ents) {
            const meta = ENTITY_KIND_META[e.kind] || {};
            const bits = [e.role || e.relation, e.notes].filter(Boolean).join(' — ');
            parts.push(`- ${meta.emoji ? meta.emoji + ' ' : ''}${e.name}${bits ? ` (${bits})` : ''}`);
        }
    }

    // Coming up — upcoming + recurring dates within ~2 months (#2/#8/#36).
    const up = [];
    for (const ev of events) {
        if (ev.visibility === 'private') continue;
        let dd = null;
        if (ev.recurrence === 'yearly' && ev.occurred_on) dd = daysUntil(nextYearly(ev.occurred_on));
        else if (ev.occurred_on) dd = daysUntil(ev.occurred_on);
        if (dd != null && dd >= 0 && dd <= 60) up.push({ ev, dd });
    }
    up.sort((a, b) => a.dd - b.dd);
    if (up.length) {
        parts.push('COMING UP:');
        for (const { ev, dd } of up.slice(0, 5)) {
            const cd = dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : `in ${dd} days`;
            parts.push(`- ${ev.title} — ${cd}`);
        }
    }

    // Know-but-never-raise (#17): Blak is aware, but must not bring it up.
    if (neverRaise.length) {
        parts.push('SENSITIVE — you KNOW these but must NEVER bring them up unless they raise it first:');
        for (const f of neverRaise) parts.push(`- ${f.label || f.key}`);
    }

    // Subtle, non-clinical recent vibe (#21). A tone cue, never a readout.
    if (mood && mood.n >= 3 && MOOD_SOFT[mood.dominant]) {
        parts.push(`RECENT VIBE: their check-ins lately lean "${MOOD_SOFT[mood.dominant]}". Let it gently shape your warmth — never diagnose, never mention "mood data".`);
    }

    parts.push('Items marked (hunch) are your own guesses — hold them loosely, never assert them as fact.');
    parts.push('=== END PROFILE ===');

    // Gentle gap-completion: at most ONE missing high-value field.
    const gaps = missingFields(facts, { limit: 1 });
    if (gaps.length) {
        parts.push(
            `GAP: you still don't know their "${gaps[0].label}". If it comes up naturally you can be a little curious — ONE light question at most, never an interrogation.`
        );
    }

    return parts.join('\n');
}

// Curated, non-sensitive fields safe to reveal to a STRANGER who reached a shared
// persona with reveal='knows_me'. Deliberately EXCLUDES location, hometown,
// backstory, family/partner/relationships, faith, money, health/mood, coping,
// sensitivities, off-limits, people/pets, dated events and gap nudges — bio only.
const SHARE_BIO_FIELDS = new Set([
    'identity:self_summary', 'identity:languages',
    'world:work', 'world:study',
    'tastes:interests', 'tastes:media_tastes', 'tastes:favorite_topics',
    'goals:short_term_goals', 'goals:long_term_dreams',
]);

/**
 * Share-safe creator projection for reveal='knows_me' persona shares: the
 * creator's name + a short, non-sensitive bio, capped in length. This is the
 * ONLY creator data a stranger's persona may see — NEVER buildKnowledgeBlock,
 * which leaks blak_only facts, sensitive-flagged fields, never-raise labels,
 * people, dates and mood into the guest's prompt (FINDING #98). Quadruple-gated:
 * SHARE_BIO_FIELDS allow-list ∩ user-marked-shareable (visibility==='shared')
 * ∩ non-sensitive ∩ not-never_raise — so any new/unknown/downgraded field
 * defaults to HIDDEN (fail-closed). Values are also de-delimited + length-capped
 * so a creator can't inject prompt structure via their own profile text.
 *
 * @param {string} userId — the CREATOR's id (persona.user_id)
 * @returns {Promise<string|null>} the bio block, or null if nothing is safe to show
 */
export async function buildCreatorBioForShare(userId, { maxChars = 600 } = {}) {
    if (!userId) return null;
    let profile = null, facts = [];
    try {
        [profile, facts] = await Promise.all([
            fetchBlaksydProfile(userId).catch(() => null),
            fetchKnowledgeFacts(userId).catch(() => []),
        ]);
    } catch (_) { return null; }

    const clean = (s) => String(s == null ? '' : s).replace(/={3,}/g, '==').replace(/[\r\n]+/g, ' ').trim();
    const safe  = (f) => !!f && isShareable(f) && !f.never_raise && !(fieldMeta(f.area, f.key)?.sensitive);

    const picked = (facts || []).filter((f) => safe(f) && SHARE_BIO_FIELDS.has(`${f.area}:${f.key}`));

    const nameFact = (facts || []).find((f) => f.area === 'identity' && f.key === 'preferred_name' && safe(f));
    const name = clean((nameFact && nameFact.value) || (profile && profile.full_name) || '').slice(0, 80);

    const bioLines = picked
        .map((f) => `- ${clean(f.label || fieldMeta(f.area, f.key)?.label || f.key)}: ${clean(f.value).slice(0, 140)}`)
        .filter((l) => l.length > 4);

    if (!name && !bioLines.length) return null;

    const parts = [];
    if (name) parts.push(`Their name is ${name}.`);
    if (bioLines.length) { parts.push('A few non-private things about them:'); parts.push(...bioLines); }

    let out = parts.join('\n');
    if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
    return out;
}
