// Context engine — turns the stored knowledge profile into the prompt block
// Blak actually carries. Smart selection (per spec): a compact CORE is always
// included; deeper facts are pulled in only when relevant to the current
// message. Also emits a gentle gap-completion hint for ONE missing field.
//
// Used by system-prompt.mjs for both chat (with the latest user message, so
// relevance works per-turn) and voice (no per-turn message — the session
// instruction is built once, so we include core + top facts).

import { fetchKnowledgeFacts } from './supabase.mjs';
import { coreFields, missingFields, fieldMeta } from './knowledge-schema.mjs';

const STOP = new Set(
    ('the a an and or but to of in on for with my your you i me is are was were be been do does did this ' +
     'that have has had it its at as so if how what when who why not no yes just like really very about').split(' ')
);

function tokens(s) {
    return (String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(t => !STOP.has(t));
}

function coreKeySet() {
    return new Set(coreFields().map(f => `${f.area}:${f.key}`));
}

function renderLine(f) {
    const label = f.label || (fieldMeta(f.area, f.key)?.label) || f.key;
    const hunch = (f.source === 'blak' && (f.confidence ?? 1) < 0.6) ? ' (hunch)' : '';
    return `- ${label}: ${String(f.value).slice(0, 160)}${hunch}`;
}

/**
 * Build the "what Blak knows" context block (or null if nothing's known yet).
 * @param {string} userId
 * @param {{latestUserText?:string, maxDetail?:number}} opts
 * @returns {Promise<string|null>}
 */
export async function buildKnowledgeBlock(userId, { latestUserText = '', maxDetail = 6 } = {}) {
    if (!userId) return null;

    let facts = [];
    try { facts = await fetchKnowledgeFacts(userId); } catch (_) { return null; }
    if (!facts.length) return null; // cold start handled by CORE_IDENTITY curiosity

    const core = coreKeySet();
    const coreFactsArr = facts.filter(f => core.has(`${f.area}:${f.key}`));
    let detail = facts.filter(f => !core.has(`${f.area}:${f.key}`));

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
        // Voice / no current message: top facts by confidence.
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
