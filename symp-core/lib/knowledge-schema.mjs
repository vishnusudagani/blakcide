// Canonical "knowledge form" taxonomy — the single source of truth for the
// user profile that Blak fills through conversation.
//
// Used by:
//   - knowledge-extractor.mjs  (what to look for in a conversation)
//   - knowledge-context.mjs    (which fields form the always-on "core" vs detail)
//   - system-prompt gap hint   (which high-value fields are still missing)
//   - /beta/profile page       (sections, labels, completeness %)
//
// Hybrid design (per spec): a FIXED detailed taxonomy below + an open bucket
// (area 'other') for anything novel Blak notices that doesn't fit a known key.
//
// Each field: { key, label, core?, sensitive? }
//   core      → always injected into context (compact 360° core)
//   sensitive → framed warmly / non-clinically; never with clinical labels
//
// This module is dependency-free and carries NO secrets, so it is safe to
// import on both the server (extractor/context) and the browser (profile page).

export const KNOWLEDGE_AREAS = [
    {
        id: 'identity',
        label: 'Who they are',
        blurb: 'The basics of who this person is.',
        fields: [
            { key: 'preferred_name', label: 'Preferred name / nickname', core: true },
            { key: 'full_name',      label: 'Full name' },
            { key: 'age',            label: 'Age / birthday' },
            { key: 'gender',         label: 'Gender & pronouns' },
            { key: 'location',       label: 'Where they live', core: true },
            { key: 'hometown',       label: "Hometown / where they're from" },
            { key: 'languages',      label: 'Languages they speak', core: true },
            { key: 'faith',          label: 'Faith / spirituality', sensitive: true },
            { key: 'self_summary',   label: 'How they describe themselves', core: true },
            { key: 'backstory',      label: 'Backstory / their story so far' },
        ],
    },
    {
        id: 'people',
        label: 'Their people',
        blurb: 'The people who matter to them.',
        fields: [
            { key: 'family',                 label: 'Family', sensitive: true },
            { key: 'partner',                label: 'Partner / relationship status', sensitive: true },
            { key: 'close_friends',          label: 'Close friends' },
            { key: 'pets',                   label: 'Pets' },
            { key: 'key_people',             label: 'Other important people (boss, mentor, roommate)' },
            { key: 'relationship_dynamics',  label: 'Who they lean on / the dynamics', sensitive: true },
        ],
    },
    {
        id: 'world',
        label: 'Their world',
        blurb: 'Work, study, and the shape of their days.',
        fields: [
            { key: 'work',              label: 'Work — role, field, how they feel about it', core: true },
            { key: 'study',             label: 'Study — course, year, pressures', core: true },
            { key: 'daily_rhythm',      label: 'Daily rhythm & sleep' },
            { key: 'living_situation',  label: 'Living situation' },
            { key: 'current_situation', label: "What's going on right now (ongoing sagas)", core: true },
            { key: 'money',             label: 'Money / pressures', sensitive: true },
        ],
    },
    {
        id: 'inner',
        label: 'Inner life',
        blurb: 'What moves them — kept warm and non-clinical.',
        fields: [
            { key: 'values',        label: 'Core values / what matters most' },
            { key: 'lifts_them',    label: 'What lifts them / sources of energy' },
            { key: 'drains_them',   label: 'What drains them / recurring stressors', sensitive: true },
            { key: 'coping',        label: 'How they cope / what helps when low', sensitive: true },
            { key: 'mood_patterns', label: 'Emotional patterns over time', sensitive: true },
            { key: 'sensitivities', label: 'Things to handle gently', core: true, sensitive: true },
        ],
    },
    {
        id: 'goals',
        label: 'Goals & growth',
        blurb: 'Where they are headed.',
        fields: [
            { key: 'short_term_goals',    label: "What they're working on now", core: true },
            { key: 'long_term_dreams',    label: 'Long-term dreams / aspirations' },
            { key: 'who_they_want_to_be', label: 'Who they want to become' },
            { key: 'habits',              label: 'Habits building / breaking' },
            { key: 'wins',                label: 'Recent wins to remember & celebrate' },
        ],
    },
    {
        id: 'tastes',
        label: 'Tastes & how to treat them',
        blurb: 'What they love, and how they like Blak to be.',
        fields: [
            { key: 'interests',         label: 'Interests & hobbies', core: true },
            { key: 'media_tastes',      label: 'Food, music, film, sport' },
            { key: 'favorite_topics',   label: 'Topics they love talking about' },
            { key: 'comms_prefs',       label: 'How they like Blak to talk (tone, length, humour)', core: true },
            { key: 'nicknames_for_blak',label: 'What they like to call Blak' },
            { key: 'off_limits',        label: 'Off-limit topics', core: true, sensitive: true },
        ],
    },
];

// The open bucket — anything Blak notices that doesn't map to a known field.
export const OPEN_AREA_ID = 'other';
export const OPEN_AREA = { id: OPEN_AREA_ID, label: 'Other things Blak noticed', blurb: 'Anything that did not fit a box above.', fields: [] };

export const KNOWLEDGE_AREA_IDS = Object.freeze([...KNOWLEDGE_AREAS.map(a => a.id), OPEN_AREA_ID]);

// Flat list of every fixed field with its area attached.
export function allFields() {
    const out = [];
    for (const area of KNOWLEDGE_AREAS) {
        for (const f of area.fields) out.push({ area: area.id, ...f });
    }
    return out;
}

// The keys that are always carried in context (the compact 360° core).
export function coreFields() {
    return allFields().filter(f => f.core);
}

export function areaById(id) {
    if (id === OPEN_AREA_ID) return OPEN_AREA;
    return KNOWLEDGE_AREAS.find(a => a.id === id) || null;
}

export function fieldMeta(areaId, key) {
    const area = areaById(areaId);
    if (!area) return null;
    return area.fields.find(f => f.key === key) || null;
}

export function isValidArea(id) {
    return KNOWLEDGE_AREA_IDS.includes(id);
}

// Build a lookup of filled keys from a flat facts array (rows of {area,key}).
function filledKeySet(facts) {
    const set = new Set();
    for (const f of (facts || [])) {
        if (f && f.area && f.key) set.add(`${f.area}:${f.key}`);
    }
    return set;
}

/**
 * Completeness as a 0–100 integer: how many of the fixed fields have a fact.
 * The open bucket does not count toward the denominator.
 */
export function computeCompleteness(facts) {
    const fields = allFields();
    if (!fields.length) return 0;
    const filled = filledKeySet(facts);
    let have = 0;
    for (const f of fields) if (filled.has(`${f.area}:${f.key}`)) have++;
    return Math.round((have / fields.length) * 100);
}

/**
 * The fixed fields that are still empty — ordered core-first — so Blak can be
 * gently curious about the highest-value gaps. Returns [{area,key,label}].
 */
export function missingFields(facts, { limit = 0 } = {}) {
    const filled = filledKeySet(facts);
    const missing = allFields().filter(f => !filled.has(`${f.area}:${f.key}`));
    missing.sort((a, b) => (b.core ? 1 : 0) - (a.core ? 1 : 0));
    return limit > 0 ? missing.slice(0, limit) : missing;
}

// ── Extended model (profile foundation, 2026-06-21) ───────────────────────
// Constants/helpers for the hybrid schema (entities, events, goals, visibility,
// settings, tombstones). Still dependency-free + safe on both server & browser.

export const VISIBILITY = Object.freeze({ SHARED: 'shared', BLAK_ONLY: 'blak_only', PRIVATE: 'private' });
export const VISIBILITY_IDS = Object.freeze(['shared', 'blak_only', 'private']);
export const VISIBILITY_META = Object.freeze({
    shared:    { label: 'Shared with your world', hint: 'Blak can weave this into a Minit brief or your Persona — always previewed before it leaves.' },
    blak_only: { label: 'Only Blak',              hint: 'Used only in your 1:1 chats & calls with Blak. Never shared anywhere else.' },
    private:   { label: 'Private',                hint: 'Kept on your profile so you can see it, but Blak never uses it in conversation.' },
});

export const ENTITY_KINDS = Object.freeze(['person', 'pet', 'place', 'org', 'thing']);
export const ENTITY_KIND_META = Object.freeze({
    person: { label: 'Person', emoji: '🧑' },
    pet:    { label: 'Pet',    emoji: '🐾' },
    place:  { label: 'Place',  emoji: '📍' },
    org:    { label: 'Org',    emoji: '🏢' },
    thing:  { label: 'Thing',  emoji: '✨' },
});

export const EVENT_KINDS   = Object.freeze(['event', 'milestone', 'anniversary', 'plan', 'memory']);
export const GOAL_KINDS     = Object.freeze(['goal', 'habit', 'dream', 'win']);
export const GOAL_STATUSES  = Object.freeze(['active', 'done', 'paused', 'dropped']);

export const PROFILE_SETTINGS_DEFAULTS = Object.freeze({
    learning_paused: false,
    enrich_gmail: false, enrich_calendar: false, enrich_music: false, enrich_location: false,
    share_minit: true, share_persona: true, share_nexus: false,
    mirror_tone: 'warm',
});

export function isValidVisibility(v) { return VISIBILITY_IDS.includes(v); }

// Normalize a fact value for tombstone matching + duplicate detection: lowercase,
// collapse non-alphanumerics to single spaces, trim.
//   "Favourite colour is Teal!" → "favourite colour is teal"
export function normalizeValue(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Soft freshness: a fact not re-seen / re-confirmed within `days` reads as stale,
// so the profile can gently ask "still true?". Pure — the caller decides whether
// to exempt user-edited facts. Returns true when fresh.
export function isFresh(fact, { days = 120 } = {}) {
    if (!fact) return false;
    const anchor = fact.last_confirmed_at || fact.last_seen_at || fact.updated_at;
    if (!anchor) return true;
    return (Date.now() - new Date(anchor).getTime()) < days * 86400000;
}

// Is this fact allowed to leave the 1:1 Blak context (Minit brief, Persona…)?
export function isShareable(fact) {
    return !!fact && fact.visibility === 'shared' && !fact.archived;
}

// May Blak use this fact in generation at all? ('private' is see-only.)
export function isUsableInContext(fact) {
    return !!fact && fact.visibility !== 'private' && !fact.archived;
}
