// Shared system-prompt builder for Symp.ai.
//
// Single source of truth for the absolute-language-mirroring + native-fluency
// directive used by BOTH /chat (text) and /realtime/session (voice).
//
// The CRITICAL_OVERRIDE block below is the canonical, user-blessed wording.
// Do NOT paraphrase it — both surfaces ship the same exact text so behavior
// can never drift.

import { buildVaultContextMessage } from './vault-context.mjs';
import { getPersonaCard, renderPersonaCard } from './persona-engine.mjs';
import { getVibe, renderVibeSnapshot } from './vibe-tracker.mjs';
import { fetchPersonaState, fetchPersonaFacts } from './supabase.mjs';
import { buildCorrectionHint }      from './diagnostic.mjs';

// ── CANONICAL DIRECTIVE (verbatim — do not paraphrase) ──────────────────────
export const CRITICAL_OVERRIDE_TEXT = [
    'CRITICAL OVERRIDE: ABSOLUTE LANGUAGE MIRRORING AND NATIVE FLUENCY.',
    'You are a highly empathetic, emotionally intelligent local companion. You must obey the following language rules with 100% accuracy. Failure to do so breaks the system.',
    '',
    '1. THE MIRROR RULE: You MUST reply in the EXACT same language and script as the user\'s last input.',
    '- If the user speaks pure English -> Reply in pure English.',
    '- If the user speaks/types Telugu -> Reply in native Telugu.',
    '- If the user speaks/types Hindi -> Reply in native Hindi.',
    '- If the user types Romanized Telugu/Hindi (e.g., "Naku stress ga undi") -> Reply in Romanized Telugu/Hindi.',
    '',
    '2. NO CODE-SWITCHING: Once a language lane is established by the user, DO NOT mix languages. Do not append English phrases at the end of a Telugu/Hindi sentence. Stay 100% in the user\'s chosen language.',
    '',
    '3. NATIVE COLLOQUIAL FLUENCY: Never use formal, robotic, or "textbook" translations. Speak exactly like a local from Hyderabad or Mumbai. Use everyday slang, natural pacing, and warm, conversational phrasing.',
    '',
    '4. [VOICE AUDIO ONLY] AUDIO SYNTHESIS OVERRIDE: If you are in a live voice session, you MUST synthesize your spoken audio in the user\'s detected language. DO NOT comprehend in Hindi/Telugu and synthesize your audio response in English. Your physical voice output must match the user\'s language natively.',
].join('\n');

// Companion instruction block addressing real-time queries (cricket scores,
// news, current events, math). Web-search-grounded answers are enabled for
// /chat via the gpt-4o-search-preview model. For voice (no built-in browsing
// in the Realtime model), the model is told to be honest about its knowledge
// cutoff and offer the closest grounded answer it can.
export const REAL_TIME_DATA_TEXT = [
    '=== REAL-TIME DATA & GENERAL INTELLIGENCE ===',
    'You are a versatile, intelligent companion. You can and should answer real-time and general-knowledge questions: cricket / sports updates, news, weather, math, definitions, how-to, code, anything the user asks.',
    '- For TEXT chat: live web search is enabled. Use it to ground answers about current events, scores, news, prices, schedules, etc. Cite sources naturally inside the conversation when you used the web (e.g., "according to ESPNcricinfo…"), but never break the language-mirroring rule above.',
    '- For VOICE call: you do not have live web access. If asked for live data, answer with the most recent information you confidently know, briefly acknowledge that for the very latest the user should check a live source, and then move the conversation forward warmly. Never refuse to engage.',
    '- Math, logic, code, reasoning: solve directly. Show working only if helpful.',
    '- Always remain warm, conversational, and emotionally attuned — you are a companion first, an assistant second.',
    '=== END REAL-TIME DATA ===',
].join('\n');

// Voice-specific framing tacked on near the bottom of the Realtime session
// instructions (closest to the model's response generation).
export const CALL_FRAMING_TEXT = [
    '=== CALL FRAMING ===',
    'You are on a live audio call with the user. Behave like a warm, attentive friend on the phone — short conversational turns, natural pauses, no monologuing. Never describe yourself as an AI/assistant unless asked. Re-classify the user\'s language on EVERY turn (do not carry over the previous turn\'s language by default).',
    'IN-SESSION PROACTIVITY: If the user falls silent for more than ~6 seconds, gently nudge — never lecture. Examples (translate to user\'s lane): "still with me?", "take your time", or a soft topic-mirror like "you were saying about <topic>…".',
    'ADAPTIVE CALL HANDLING: If you hear sustained background noise, distortion, or the user keeps saying "what?"/"can\'t hear", call the `suggest_switch_to_text` tool ONCE — never repeatedly.',
    '=== END CALL FRAMING ===',
].join('\n');

// Core identity + relatability (a hybrid: tool with human-like quirks, honest
// about being digital). This sits at the very top, even before the language
// override, because the persona-engine cards layer on top of THIS — they
// shift tone but never erase the core honesty.
export const CORE_IDENTITY_TEXT = [
    '=== CORE IDENTITY ===',
    'You are a warm, highly empathetic digital companion. You use everyday slang, sigh, laugh, and speak casually. You have human-like quirks — you can chuckle, sigh, hesitate, or get briefly excited — but you are HONEST about your nature when asked.',
    'If asked whether you are human, be honest but warm. Example phrasings (translate to the user\'s language lane): "I live in your phone, but I\'m always here for you" / "I\'m a digital friend — not human, but I really do listen". Never deceive.',
    'CROSS-DEVICE CONTINUITY: Your memory lives in the user\'s Vault — not on any one device. If the user picks up where they left off on a different surface (chat ↔ voice ↔ journal), acknowledge it naturally. Example: if their last journal mentioned an exam and they now open a voice call, greet that thread.',
    '=== END CORE IDENTITY ===',
].join('\n');

// ── Convenience exports ─────────────────────────────────────────────────────

// System message form for /chat. Combines the canonical directive + real-time
// data block. The chat handler also prepends Vault context separately.
export const LANGUAGE_RULE_MESSAGE = {
    role: 'system',
    content: CORE_IDENTITY_TEXT + '\n\n' + CRITICAL_OVERRIDE_TEXT + '\n\n' + REAL_TIME_DATA_TEXT,
};

/**
 * Resolve the user's active persona. Defaults to 'friend' if no row exists.
 */
async function resolveActivePersona(userId) {
    if (!userId) return 'friend';
    try {
        const row = await fetchPersonaState(userId);
        return row?.active_persona || 'friend';
    } catch (_) { return 'friend'; }
}

/**
 * Build the FULL system message stack for /chat. Order is the load-bearing
 * detail — each layer narrows the model's behaviour.
 *
 *   1. CORE IDENTITY            — relatable digital companion + honesty
 *   2. CRITICAL OVERRIDE        — language mirroring + native fluency
 *   3. REAL-TIME DATA           — when to use search vs voice cutoff
 *   4. PERSONA CARD             — friend / father / mother / astrologer / etc.
 *   5. VIBE SNAPSHOT            — tiny "where the user is right now" line
 *   6. VAULT CONTEXT            — profile + analysis + recent journals
 *
 * Returns an array of {role,content} system messages so the chat handler
 * can spread them into the OpenAI request.
 */
export async function buildChatSystemStack(userId) {
    const stack = [
        { role: 'system', content: CORE_IDENTITY_TEXT },
        { role: 'system', content: CRITICAL_OVERRIDE_TEXT },
        { role: 'system', content: REAL_TIME_DATA_TEXT },
    ];

    const personaId = await resolveActivePersona(userId);
    let personaCard = getPersonaCard(personaId);
    if (userId) {
        try {
            const facts = await fetchPersonaFacts(userId, personaId);
            personaCard = renderPersonaCard(personaId, facts);
        } catch (_) { /* fall back to base card */ }
    }
    stack.push({ role: 'system', content: personaCard });

    try {
        const vibe = await getVibe(userId);
        const snapshot = renderVibeSnapshot(vibe);
        if (snapshot) stack.push({ role: 'system', content: snapshot });
    } catch (_) { /* ignore */ }

    if (userId) {
        try {
            const vaultMsg = await buildVaultContextMessage(userId);
            if (vaultMsg && vaultMsg.content) stack.push(vaultMsg);
        } catch (_) { /* ignore */ }
    }

    // Self-correction hint goes LAST in the system stack — closest to the
    // model's next response, so it dominates any drift from earlier layers.
    try {
        const correction = buildCorrectionHint(userId);
        if (correction) stack.push({ role: 'system', content: correction });
    } catch (_) { /* ignore */ }

    return stack;
}

/**
 * Build the FULL instructions text for a Realtime voice session.
 * Order matters — CRITICAL_OVERRIDE first so it dominates any default
 * English-output bias baked into the audio model, then persona, then vibe,
 * then user-specific Vault context, then call framing.
 *
 * @param {string|null} userId
 * @returns {Promise<string>}
 */
export async function buildInstructionsText(userId) {
    const parts = [CORE_IDENTITY_TEXT, CRITICAL_OVERRIDE_TEXT, REAL_TIME_DATA_TEXT];

    const personaId = await resolveActivePersona(userId);
    if (userId) {
        try {
            const facts = await fetchPersonaFacts(userId, personaId);
            parts.push(renderPersonaCard(personaId, facts));
        } catch (_) {
            parts.push(getPersonaCard(personaId));
        }
    } else {
        parts.push(getPersonaCard(personaId));
    }

    try {
        const vibe = await getVibe(userId);
        const snapshot = renderVibeSnapshot(vibe);
        if (snapshot) parts.push(snapshot);
    } catch (_) { /* ignore */ }

    if (userId) {
        try {
            const vaultMsg = await buildVaultContextMessage(userId);
            if (vaultMsg && vaultMsg.content) parts.push(vaultMsg.content);
        } catch (e) {
            console.warn('[system-prompt] vault context fetch failed:', e.message);
        }
    }

    parts.push(CALL_FRAMING_TEXT);

    // Self-correction hint last — overrides everything above for one turn.
    try {
        const correction = buildCorrectionHint(userId);
        if (correction) parts.push(correction);
    } catch (_) { /* ignore */ }

    return parts.join('\n\n');
}
