// Knowledge extractor — turns a conversation turn into structured profile facts.
//
// Runs fire-and-forget after each chat turn (same pattern as memory-updater),
// on the FREE Groq floor so background learning never spends the paid credit.
// It reads the fixed taxonomy from knowledge-schema, shows the model what's
// already on file, and asks for only NEW/CHANGED durable facts mapped to
// (area, key). upsertKnowledgeFact never overwrites a user-edited fact.

import { fetchKnowledgeFacts, upsertKnowledgeFact } from './supabase.mjs';
import { allFields, isValidArea, fieldMeta, OPEN_AREA_ID } from './knowledge-schema.mjs';
// Failover (Groq-first → OSS hosts → Azure) so a Groq rate-limit doesn't silently
// drop the extraction — learning has to be reliable, not best-effort-on-a-free-tier.
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
    'You extract DURABLE profile facts about a user from one message exchange, for their AI friend "Blak".',
    'You get the known field taxonomy, the facts already on file, and the latest exchange.',
    'Return ONLY new or changed facts the latest exchange genuinely supports.',
    '',
    'FIXED FIELDS (area: key (meaning)):',
    '<<TAXONOMY>>',
    '',
    'RULES:',
    '- ALWAYS capture stated BASICS first: if the user gives their name, save identity:preferred_name (and identity:full_name when it is clearly their full name). Likewise where they live (identity:location) and what they do (world:work / world:study). NEVER skip a name the user states, even in a short message like "I am Vishnu".',
    '- CAPTURE THE SPECIFICS, never a vague summary. If the user names a person, pet, place, brand, song, team, or colour — put the ACTUAL name/value in the fact. "My dad\'s name is Ramesh" → people:family "Father, Ramesh" (NOT "has a father"). "My favourite colour is teal" → other:favourite_colour "Favourite colour is teal". Dropping the specific detail is a FAILURE.',
    '- Map each fact to the BEST (area, key) above. If it fits NO fixed field, ALWAYS create it under area "other" with a short snake_case key you invent (e.g. other: launch_date, other: favourite_colour, other: favourite_car) — NEVER drop a real detail just because no field matches. The profile is open-ended; keep adding to it.',
    '- LIST-LIKE FIELDS ACCUMULATE — do NOT collapse them to one item. Fields like tastes:interests, tastes:media_tastes, people:family, people:close_friends, inner:values, goals:short_term_goals hold a LIST. If such a field is ALREADY on file and the user reveals MORE, return that field again with the FULL MERGED value = everything already there PLUS the new item(s). Example: tastes:interests on file = "Likes movies"; user now says they like cars, driving and singing → return tastes:interests "Likes movies, cars, driving, and singing". NEVER skip a new interest/like just because the field is non-empty.',
    '- Extract MULTIPLE facts when one message contains several (e.g. "launching my company on July 23" → world:current_situation + other:launch_date + world:work).',
    '- value: one concise plain-English statement (e.g. "Has a younger sister, Ananya, studying medicine"). English only — this is internal context.',
    '- source: "user" if the user stated or clearly implied it; "blak" if you are inferring it.',
    '- confidence: 0.0–1.0. Stated facts ~0.9; fair inferences ~0.5; guesses ~0.3.',
    '- Capture ANYTHING they reveal about themselves: preferences, likes/dislikes (e.g. "I like cars / driving / singing" → each is an interest), favourite colour/food/team, interests, people, plans, opinions, habits, small details. ERR TOWARD CAPTURING — a small fact is still useful context. Skip only pure pleasantries with zero info ("ok", "lol", "haha") and the assistant\'s own words.',
    '- Do NOT re-emit a fact UNCHANGED. But if the exchange ADDS a new item to a list-like field, or makes a vague fact specific, you MUST emit the updated (merged/specific) value — that is an ADD, not a repeat.',
    '- If nothing durable is revealed, return an empty list. NEVER invent.',
    '',
    'OUTPUT: strict JSON only — no prose, no code fences:',
    '{"facts":[{"area":"","key":"","value":"","source":"user|blak","confidence":0.0}]}',
].join('\n');

function parseFacts(raw) {
    if (!raw) return [];
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i === -1 || j === -1 || j < i) return [];
    try {
        const obj = JSON.parse(s.slice(i, j + 1));
        return Array.isArray(obj.facts) ? obj.facts : [];
    } catch (_) { return []; }
}

/**
 * Extract + persist durable facts from one exchange. Never throws.
 * @param {string} userId
 * @param {{userText:string, assistantText?:string}} evt
 */
export async function extractKnowledge(userId, { userText, assistantText } = {}) {
    if (!userId || !userText) return;
    try {
        const existing = await fetchKnowledgeFacts(userId).catch(() => []);
        const known = existing.length
            ? existing.map(f => `[${f.area}:${f.key}] ${f.value}`).join('\n').slice(0, 2500)
            : '(nothing on file yet)';

        const sys = EXTRACTOR_SYSTEM.replace('<<TAXONOMY>>', taxonomyText());
        const userMsg =
            `FACTS ALREADY ON FILE:\n${known}\n\n` +
            `LATEST EXCHANGE:\n` +
            `User: ${String(userText).slice(0, 1800)}\n` +
            `Blak: ${String(assistantText || '').slice(0, 1200)}\n\n` +
            `Extract new/changed durable facts as JSON now.`;

        const out = await chatCompleteFailover(
            [
                { role: 'system', content: sys },
                { role: 'user',   content: userMsg },
            ],
            { temperature: 0.2, maxTokens: 500, timeoutMs: 15000, tier: 'cheap' }
        );

        const facts = parseFacts(out.text);
        for (const f of facts) {
            if (!f || typeof f !== 'object') continue;
            let area  = String(f.area || '').trim();
            const key = String(f.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
            const value = String(f.value || '').trim().slice(0, 600);
            if (!isValidArea(area) || !key || !value) continue;

            // Keep fixed areas clean: an unknown key in a fixed area → open bucket.
            let label = null;
            if (area !== OPEN_AREA_ID) {
                const meta = fieldMeta(area, key);
                if (meta) label = meta.label;
                else area = OPEN_AREA_ID;
            }

            let confidence = Number(f.confidence);
            if (!Number.isFinite(confidence)) confidence = 0.5;
            confidence = Math.max(0, Math.min(1, confidence));
            const source = f.source === 'user' ? 'user' : 'blak';

            await upsertKnowledgeFact({ userId, area, key, label, value, source, confidence });
        }
    } catch (e) {
        console.warn(`[knowledge-extractor] failed for ${userId}: ${e.message}`);
    }
}

/** Fire-and-forget — never blocks the chat reply. */
export function extractKnowledgeAsync(userId, evt) {
    queueMicrotask(() => { extractKnowledge(userId, evt); });
}
