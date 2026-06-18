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
