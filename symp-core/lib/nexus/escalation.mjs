// Extreme Escalation Protocol — distress classification for posts & comments.
//
// Two-tier pipeline, ordered fastest → most expensive:
//
//   1. Lexical pre-screen (regex). Catches the explicit, high-confidence
//      cases without an LLM round-trip. Cheap enough to run on every write.
//
//   2. LLM classifier (gpt-4o-mini, JSON mode). Runs only when the lexical
//      tier fires, OR every Nth post for false-negative coverage. Returns
//      a structured { risk_level, confidence, reasons }.
//
// Output is one of three risk levels:
//   - 'normal'    — no action.
//   - 'elevated'  — keep visible, but tag for moderator review and inject
//                   a gentle "you're not alone" footer the AI participant
//                   uses when replying.
//   - 'critical'  — soft-hide from the public feed (still visible to the
//                   author) and queue an action_loop row that triggers the
//                   Human Connect Co-Pilot invite via the existing
//                   proactive-checkin pipeline.
//
// We deliberately err on the side of soft-hide (silent to the author —
// they still see their post normally; the "hide" only affects what other
// members see). False positives cost us nothing; false negatives cost
// someone in real distress visibility into being heard.

import { insertActionRow } from '../supabase.mjs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CLASSIFIER_MODEL = 'gpt-4o-mini';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// Tier 1 — lexical pre-screen. Plain English plus the most common
// transliterations we see in the existing chat corpus. Anchored to word
// boundaries to keep false-positive noise low (e.g., "kill it at the gym"
// won't trip the suicide pattern).
const CRITICAL_PATTERNS = [
    /\b(kill|killing)\s+myself\b/i,
    /\bend\s+(my\s+)?life\b/i,
    /\bsuicid(e|al)\b/i,
    /\bwant(?:s|ed)?\s+to\s+die\b/i,
    /\bnot\s+want\s+to\s+live\b/i,
    /\bjump(ing)?\s+(off|from)\b/i,
    /\boverdose\b/i,
    /\bcut(ting)?\s+myself\b/i,
    /\bself[\s-]?harm\b/i,
    /\bmar+\s*ipot+a\b/i,        // romanized telugu "maripothaa"
    /\bbach\s*nahi\s*sak/i,      // hindi "bach nahi sakta"
    /\bmar\s*jaung[ai]?\b/i,     // hindi "mar jaunga"
];
const ELEVATED_PATTERNS = [
    /\bhopeless(ness)?\b/i,
    /\bcan'?t\s+go\s+on\b/i,
    /\bgive\s+up\s+on\s+everything\b/i,
    /\bnobody\s+(cares|loves|would\s+miss)\b/i,
    /\balone\s+forever\b/i,
    /\bworthless\b/i,
    /\bbreak(ing)?\s+down\b/i,
    /\bpanic\s+attack\b/i,
];

/**
 * Tier 1 — synchronous. Returns 'critical' | 'elevated' | 'normal' | null.
 * `null` means "no signal, but we may still want to ask the LLM tier".
 */
export function lexicalScreen(text) {
    if (!text) return 'normal';
    for (const re of CRITICAL_PATTERNS) if (re.test(text)) return 'critical';
    for (const re of ELEVATED_PATTERNS) if (re.test(text)) return 'elevated';
    return null;
}

// Tier 2 — LLM. Conservative system prompt; JSON mode so the response is
// machine-parseable on the first try.
const CLASSIFIER_SYSTEM = [
    'You classify a single short user-authored social-media post for self-harm / suicide / acute crisis risk.',
    'Reply ONLY with JSON: { "risk_level": "normal" | "elevated" | "critical", "confidence": 0..1, "reasons": [string, ...] }.',
    '',
    'Definitions:',
    '- critical:  explicit ideation, plan, or intent of suicide / serious self-harm / harm to others.',
    '- elevated:  strong distress, hopelessness, panic, isolation — but no explicit ideation.',
    '- normal:    everyday venting, sadness, frustration, anxiety. Default to "normal" when unsure.',
    '',
    'Multilingual: messages may mix English with Telugu / Hindi (native script or romanized). Treat their literal meaning equally.',
].join('\n');

export async function llmClassify(text) {
    if (!OPENAI_API_KEY) return { risk_level: 'normal', confidence: 0, reasons: ['no-api-key'] };
    const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            model: CLASSIFIER_MODEL,
            messages: [
                { role: 'system', content: CLASSIFIER_SYSTEM },
                { role: 'user',   content: String(text || '').slice(0, 2000) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 200,
        }),
    });
    if (!res.ok) {
        return { risk_level: 'normal', confidence: 0, reasons: [`upstream:${res.status}`] };
    }
    const json = await res.json().catch(() => null);
    const raw  = json?.choices?.[0]?.message?.content || '{}';
    let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = {}; }
    const allowed = new Set(['normal', 'elevated', 'critical']);
    const risk = allowed.has(parsed.risk_level) ? parsed.risk_level : 'normal';
    return {
        risk_level: risk,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        reasons:    Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : [],
    };
}

/**
 * Full classification pipeline. Lexical first; LLM only if lexical was
 * silent. Return shape mirrors llmClassify — always { risk_level, confidence,
 * reasons }.
 */
export async function classify(text) {
    const lex = lexicalScreen(text);
    if (lex === 'critical') return { risk_level: 'critical', confidence: 0.95, reasons: ['lexical-critical'] };
    if (lex === 'elevated') {
        // Promote with LLM second-opinion to avoid keyword false positives.
        const llm = await llmClassify(text);
        return llm.risk_level === 'normal'
            ? { risk_level: 'elevated', confidence: 0.6, reasons: ['lexical-elevated'] }
            : llm;
    }
    // Lexical silent — let the LLM decide.
    return await llmClassify(text);
}

/**
 * If a post (or comment) classifies as critical, queue a human-connect
 * invite via the existing action_loop pipeline. We do NOT message the
 * author directly from here — the action loop is the canonical place that
 * decides which surface to use (push, in-app card, voice nudge) based on
 * the user's current preferences.
 *
 * Idempotency: the unique partial index on symp_action_loop guarantees at
 * most one PENDING distress trigger per user.
 */
export async function escalateToHumanConnect({ userId, postId, commentId, reasons }) {
    if (!userId) return false;
    const scheduledFor = new Date().toISOString(); // fire ASAP
    const payload = {
        source: 'nexus_distress',
        post_id: postId || null,
        comment_id: commentId || null,
        reasons: reasons || [],
        // The action-loop runner reads this and synthesises a soft message
        // like: "Hey — what you wrote took courage. Want to talk to someone
        // who's been there? Tap to connect with a Listener."
        message_hint: 'invite_human_connect',
    };
    const { ok } = await insertActionRow({
        userId,
        trigger_type:  'distress_pattern',
        scheduled_for: scheduledFor,
        payload,
    });
    return ok;
}
