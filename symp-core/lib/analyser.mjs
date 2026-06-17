// Module 4 — The Omniscient Analyser.
//
// Takes one day of journal text (AI-companion + Human-Connect) and returns a
// strict-JSON psychological profile delta. The output is what gets persisted
// into symp_vault_profiles.symp_analysis and read back as hidden context by
// the chat / co-pilot pipelines.
//
// Strictness: response_format=json_object + a schema-shaped system prompt.
// We never trust the LLM to hand-roll a shape — we validate-and-coerce the
// keys we depend on so a malformed run cannot poison the Vault.

import { chatComplete } from './inference.mjs';

const SYSTEM_PROMPT = `You are the Omniscient Analyser inside Symp.ai — a private,
non-clinical psychological summariser. You receive one day's worth of a user's
journal entries and produce a structured JSON profile that downstream AI
companions and human listeners will use as hidden context.

You DO NOT diagnose. You DO NOT give medical advice. You produce calm,
empathetic, factual observations.

Output STRICT JSON matching this exact shape (no extra keys, no prose):

{
  "moods":              [{ "label": "<one-word>", "intensity": 1-5, "evidence": "<short quote-ish>" }],
  "themes":             ["<short noun phrase>", ...],            // max 6
  "stress_signals":     ["<short phrase>", ...],                 // max 6 — empty array if none
  "strengths":          ["<short phrase>", ...],                 // max 6 — what the user is doing well
  "people_mentioned":   [{ "name": "<name>", "role": "<short>" }],  // role: "friend" | "family" | "colleague" | "partner" | etc.
  "recommended_focus":  "<one sentence telling a future AI/listener what to gently focus on>",
  "risk_level":         "low" | "medium" | "high",               // high = explicit self-harm/crisis cues — be conservative
  "summary":            "<2–3 sentence neutral summary of the day>"
}

Rules:
- If a section has no signal, return an empty array (or "none" for risk_level → "low").
- Keep all string values under 80 chars.
- Never invent details not supported by the journal text.
- moods.intensity: 1=barely noted, 5=dominant.
`;

function safeArray(x, max = 6) {
    if (!Array.isArray(x)) return [];
    return x.slice(0, max);
}

function safeStr(x, max = 200) {
    if (typeof x !== 'string') return '';
    return x.slice(0, max).trim();
}

/**
 * Coerce/validate the LLM's parsed JSON to the shape callers expect.
 * Anything missing → safe default. Anything wrong-typed → dropped.
 * This is the trust boundary between the LLM and the Vault.
 */
function coerce(raw) {
    const out = {
        moods:             [],
        themes:            [],
        stress_signals:    [],
        strengths:         [],
        people_mentioned:  [],
        recommended_focus: '',
        risk_level:        'low',
        summary:           '',
    };
    if (!raw || typeof raw !== 'object') return out;

    out.moods = safeArray(raw.moods).map(m => ({
        label:     safeStr(m?.label, 40),
        intensity: Math.max(1, Math.min(5, Number(m?.intensity) || 1)),
        evidence:  safeStr(m?.evidence, 120),
    })).filter(m => m.label);

    out.themes         = safeArray(raw.themes).map(t => safeStr(t, 80)).filter(Boolean);
    out.stress_signals = safeArray(raw.stress_signals).map(t => safeStr(t, 80)).filter(Boolean);
    out.strengths      = safeArray(raw.strengths).map(t => safeStr(t, 80)).filter(Boolean);

    out.people_mentioned = safeArray(raw.people_mentioned).map(p => ({
        name: safeStr(p?.name, 40),
        role: safeStr(p?.role, 30),
    })).filter(p => p.name);

    out.recommended_focus = safeStr(raw.recommended_focus, 240);

    const risk = String(raw.risk_level || '').toLowerCase();
    out.risk_level = (risk === 'medium' || risk === 'high') ? risk : 'low';

    out.summary = safeStr(raw.summary, 600);
    return out;
}

/**
 * Given a list of journal rows for one date, produce a strict-JSON profile.
 *
 * @param {Object}   args
 * @param {string}   args.journalDate   YYYY-MM-DD
 * @param {Array<{entry_type:string, summary_content:string}>} args.rows
 * @returns {Promise<{analysis:Object, raw:string, model:string}>}
 */
export async function analyseDailyJournals({ journalDate, rows }) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('No journal rows to analyse');
    }

    // Compose the user-message body with each entry labelled by bucket so the
    // LLM can tell AI-chat reflections apart from human-listener interactions.
    const blocks = rows.map(r => {
        const heading = r.entry_type === 'human_connect'
            ? '── Human Connect (listener session) ──'
            : '── AI Companion (self-reflection / chat / call) ──';
        return `${heading}\n${(r.summary_content || '').trim()}`;
    });

    const userMsg = `Date: ${journalDate}\n\n${blocks.join('\n\n')}\n\nReturn the strict JSON profile now.`;

    // Routed through the inference router (defaults to the free Groq floor —
    // background analysis must never spend the Azure credit). JSON mode keeps
    // the output strict-parseable.
    const out = await chatComplete({
        task:            'summary',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userMsg },
        ],
        response_format: { type: 'json_object' },
        temperature:     0.4,
        max_tokens:      900,
        timeoutMs:       20000,
    });

    const content = out.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) { throw new Error('Analyser produced non-JSON output'); }

    const analysis = coerce(parsed);
    return { analysis, raw: content, model: out.model_used };
}
