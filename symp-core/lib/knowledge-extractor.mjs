// Knowledge extractor v2 — turns one conversation turn into structured profile
// FACTS, first-class ENTITIES (people / pets / places), and dated EVENTS.
//
// Runs fire-and-forget after each chat/voice/call turn (same pattern as the
// memory-updater), on the cheap LLM floor with failover so background learning
// is reliable without spending paid credit.
//
// v2 adds (part of the /beta/profile build-out):
//   • evidence snippet + provenance (source_kind / source_ref) → the
//     "why does Blak think this?" trust surface (#11/#12)
//   • entity extraction (#1) and dated-event extraction (#2)
//   • tombstone-awareness — never relearn something the user told Blak to
//     forget (#20)
//   • respects the user's off-the-record / pause-learning setting (#18)
//
// upsertKnowledgeFact still never overwrites a user-edited fact.

import {
    fetchKnowledgeFacts, upsertKnowledgeFact, upsertEntity, upsertEvent,
    fetchTombstones, fetchProfileSettings,
} from './supabase.mjs';
import { isValidArea, fieldMeta, allFields, OPEN_AREA_ID, ENTITY_KINDS, EVENT_KINDS, normalizeValue } from './knowledge-schema.mjs';
// Failover (Groq-first → OSS hosts → Azure) so a rate-limit doesn't silently
// drop the extraction — learning has to be reliable, not best-effort.
import { chatCompleteFailover } from './llm-providers.mjs';

function taxonomyText() {
    const byArea = {};
    for (const f of allFields()) {
        (byArea[f.area] ||= []).push(`${f.key} (${f.label})`);
    }
    return Object.entries(byArea)
        .map(([area, keys]) => `- ${area}: ${keys.join('; ')}`)
        .join('\n');
}

const EXTRACTOR_SYSTEM = [
    'You extract DURABLE profile FACTS, the PEOPLE/PETS/PLACES, and the DATED EVENTS from one message exchange, for the user\'s AI friend "Blak".',
    'You get the known field taxonomy, the facts already on file, today\'s date, and the latest exchange.',
    'Return ONLY new or changed items the latest exchange genuinely supports.',
    '',
    'FIXED FIELDS (area: key (meaning)):',
    '<<TAXONOMY>>',
    '',
    'TODAY IS <<TODAY>> — use it to resolve dates like "next Friday" or "July 23" into YYYY-MM-DD.',
    '',
    'RULES FOR FACTS:',
    '- ALWAYS capture stated BASICS first: a stated name → identity:preferred_name (and identity:full_name when clearly a full name); where they live → identity:location; what they do → world:work / world:study. NEVER skip a name, even in "I am Vishnu".',
    '- CAPTURE THE SPECIFICS, never a vague summary. Name the actual person/pet/place/brand/song/team/colour. "My dad\'s name is Ramesh" → people:family "Father, Ramesh" (NOT "has a father"). Dropping the specific detail is a FAILURE.',
    '- Map each fact to the BEST (area, key). If it fits NO fixed field, create it under area "other" with a short snake_case key you invent (e.g. other: favourite_colour). NEVER drop a real detail.',
    '- LIST-LIKE FIELDS ACCUMULATE — do NOT collapse to one item. tastes:interests, tastes:media_tastes, people:family, people:close_friends, inner:values, goals:short_term_goals hold a LIST. If already on file and the user reveals MORE, return that field again with the FULL MERGED value (everything already there PLUS the new item).',
    '- Extract MULTIPLE facts when one message contains several.',
    '- value: one concise plain-English statement. English only — internal context.',
    '- source: "user" if stated/clearly implied; "blak" if you are inferring it.',
    '- confidence: 0.0–1.0. Stated ~0.9; fair inference ~0.5; guess ~0.3.',
    '- evidence: a SHORT phrase (≤12 words) grounding WHY you believe it, in their own framing (e.g. "said his sister Ananya studies medicine"). Shown to the user.',
    '- Capture ANYTHING they reveal: preferences, likes/dislikes, favourites, interests, plans, opinions, habits, small details. ERR TOWARD CAPTURING. Skip only pure pleasantries ("ok", "lol") and the assistant\'s own words.',
    '- Do NOT re-emit a fact UNCHANGED. But adding a list item or making a vague fact specific IS an ADD — emit the merged/specific value.',
    '',
    'RULES FOR ENTITIES (real people, pets, places, orgs, things that matter):',
    '- Whenever a real person/pet/place/org is named or clearly referenced, emit an entity: kind + name + (role/relation/notes). "my sister Ananya is in med school" → {kind:"person", name:"Ananya", role:"sister", notes:"in medical school"}.',
    '- sentiment: optional -1..1 only if their FEELING toward it is clear (warm=0.8, strained=-0.5). Omit otherwise.',
    '- ALSO emit the matching fact (e.g. people:family) — entities and facts complement each other.',
    '',
    'RULES FOR EVENTS (anything with a date / a "when"):',
    '- Emit an event for a date, plan, milestone, or anniversary. date = YYYY-MM-DD when you can resolve it from today\'s date; recurrence "yearly" for birthdays/anniversaries.',
    '- "launching my company on July 23" → {title:"Company launch", kind:"plan", date:"<<TODAY-year>>-07-23"}. "my birthday is March 2" → {title:"Birthday", kind:"anniversary", date:"...-03-02", recurrence:"yearly"}.',
    '',
    'If nothing durable is revealed, return empty lists. NEVER invent.',
    '',
    'OUTPUT: strict JSON only — no prose, no code fences:',
    '{"facts":[{"area":"","key":"","value":"","source":"user|blak","confidence":0.0,"evidence":""}],"entities":[{"kind":"person|pet|place|org|thing","name":"","role":"","relation":"","notes":"","sentiment":0.0,"source":"user|blak","confidence":0.0}],"events":[{"title":"","kind":"event|milestone|anniversary|plan|memory","date":"YYYY-MM-DD","recurrence":"","notes":"","source":"user|blak","confidence":0.0}]}',
].join('\n');

function toISODate(s) {
    if (!s) return null;
    const str = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
        const y = d.getUTCFullYear();
        if (y > 1900 && y < 2200) return d.toISOString().slice(0, 10);
    }
    return null;
}

function parsePayload(raw) {
    const empty = { facts: [], entities: [], events: [] };
    if (!raw) return empty;
    let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j === -1 || j < i) return empty;
    try {
        const o = JSON.parse(s.slice(i, j + 1));
        return {
            facts:    Array.isArray(o.facts)    ? o.facts    : [],
            entities: Array.isArray(o.entities) ? o.entities : [],
            events:   Array.isArray(o.events)   ? o.events   : [],
        };
    } catch (_) { return empty; }
}

function buildTombstoneIndex(tombs) {
    const factKeys = new Set(), values = new Set(), entities = new Set();
    for (const t of (tombs || [])) {
        if (t.scope === 'entity' && t.value_norm) entities.add(t.value_norm);
        else if (t.area && t.key) factKeys.add(`${t.area}:${t.key}`);
        if (t.value_norm) values.add(t.value_norm);
    }
    return { factKeys, values, entities };
}

/**
 * Extract + persist durable facts, entities and events from one exchange.
 * Never throws.
 * @param {string} userId
 * @param {{userText:string, assistantText?:string, sourceKind?:string, sourceRef?:string}} evt
 */
export async function extractKnowledge(userId, { userText, assistantText, sourceKind = 'chat', sourceRef = null } = {}) {
    if (!userId || !userText) return;
    try {
        // Off-the-record / paused learning (#18) — learn nothing this turn.
        const settings = await fetchProfileSettings(userId).catch(() => null);
        if (settings && settings.learning_paused) return;

        const [existing, tombs] = await Promise.all([
            fetchKnowledgeFacts(userId).catch(() => []),
            fetchTombstones(userId).catch(() => []),
        ]);
        const tomb = buildTombstoneIndex(tombs);

        const known = existing.length
            ? existing.map(f => `[${f.area}:${f.key}] ${f.value}`).join('\n').slice(0, 2500)
            : '(nothing on file yet)';

        const today = new Date().toISOString().slice(0, 10);
        const sys = EXTRACTOR_SYSTEM
            .replace('<<TAXONOMY>>', taxonomyText())
            .replace(/<<TODAY-year>>/g, today.slice(0, 4))
            .replace('<<TODAY>>', today);
        const userMsg =
            `FACTS ALREADY ON FILE:\n${known}\n\n` +
            `LATEST EXCHANGE:\n` +
            `User: ${String(userText).slice(0, 1800)}\n` +
            `Blak: ${String(assistantText || '').slice(0, 1200)}\n\n` +
            `Extract new/changed durable facts, people/pets/places, and dated events as JSON now.`;

        const out = await chatCompleteFailover(
            [
                { role: 'system', content: sys },
                { role: 'user',   content: userMsg },
            ],
            { temperature: 0.2, maxTokens: 700, timeoutMs: 15000, tier: 'cheap' }
        );

        const { facts, entities, events } = parsePayload(out.text);
        const nowIso = new Date().toISOString();

        // ── Facts ──────────────────────────────────────────────────────────
        for (const f of facts) {
            if (!f || typeof f !== 'object') continue;
            let area  = String(f.area || '').trim();
            const key = String(f.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
            const value = String(f.value || '').trim().slice(0, 600);
            if (!isValidArea(area) || !key || !value) continue;

            let label = null;
            if (area !== OPEN_AREA_ID) {
                const meta = fieldMeta(area, key);
                if (meta) label = meta.label;
                else area = OPEN_AREA_ID;
            }
            // Tombstone guard (#20): never relearn a forgotten fact/value.
            if (tomb.factKeys.has(`${area}:${key}`) || tomb.values.has(normalizeValue(value))) continue;

            let confidence = Number(f.confidence);
            if (!Number.isFinite(confidence)) confidence = 0.5;
            confidence = Math.max(0, Math.min(1, confidence));
            const source = f.source === 'user' ? 'user' : 'blak';
            const evidence = f.evidence ? String(f.evidence).trim().slice(0, 240) : null;

            await upsertKnowledgeFact({ userId, area, key, label, value, source, confidence, evidence, evidenceAt: nowIso, sourceKind, sourceRef });
        }

        // ── Entities (#1) ───────────────────────────────────────────────────
        for (const e of entities) {
            if (!e || typeof e !== 'object') continue;
            const kind = String(e.kind || '').trim().toLowerCase();
            const name = String(e.name || '').trim().slice(0, 80);
            if (!ENTITY_KINDS.includes(kind) || !name) continue;
            if (tomb.entities.has(normalizeValue(name))) continue;

            let confidence = Number(e.confidence);
            if (!Number.isFinite(confidence)) confidence = 0.5;
            confidence = Math.max(0, Math.min(1, confidence));
            let sentiment = Number(e.sentiment);
            sentiment = Number.isFinite(sentiment) ? Math.max(-1, Math.min(1, sentiment)) : null;

            await upsertEntity({
                userId, kind, name,
                role:     e.role     ? String(e.role).slice(0, 80)      : null,
                relation: e.relation ? String(e.relation).slice(0, 80)  : null,
                notes:    e.notes    ? String(e.notes).slice(0, 300)    : null,
                sentiment,
                source: e.source === 'user' ? 'user' : 'blak',
                confidence,
            });
        }

        // ── Events (#2) ─────────────────────────────────────────────────────
        for (const ev of events) {
            if (!ev || typeof ev !== 'object') continue;
            const title = String(ev.title || '').trim().slice(0, 140);
            if (!title) continue;
            if (tomb.values.has(normalizeValue(title))) continue;
            const occurredOn = toISODate(ev.date);
            const kind = EVENT_KINDS.includes(ev.kind) ? ev.kind : 'event';
            const recurrence = ['yearly', 'monthly', 'weekly'].includes(ev.recurrence) ? ev.recurrence : null;

            let confidence = Number(ev.confidence);
            if (!Number.isFinite(confidence)) confidence = 0.5;
            confidence = Math.max(0, Math.min(1, confidence));

            await upsertEvent({
                userId, title, kind, occurredOn, recurrence,
                notes: ev.notes ? String(ev.notes).slice(0, 300) : null,
                source: ev.source === 'user' ? 'user' : 'blak',
                sourceKind, sourceRef, confidence,
            });
        }
    } catch (e) {
        console.warn(`[knowledge-extractor] failed for ${userId}: ${e.message}`);
    }
}

/** Fire-and-forget — never blocks the chat reply. */
export function extractKnowledgeAsync(userId, evt) {
    queueMicrotask(() => { extractKnowledge(userId, evt); });
}
