// Per-persona rolling memory — the "this character remembers you" engine.
//
// After each fantasy-persona chat turn (off the request path, via
// blak-learn-background), we merge the latest exchange into a concise, evolving
// memory the persona keeps about THIS user and their history together, stored in
// symp_persona_memory (one row per user×persona). system-prompt.mjs injects it
// into every future chat + call with that persona, so the character remembers
// across sessions — distinct from Blak's global profile (profiles.user_memory).
//
// Cost: routed to the FREE Groq floor (background work never spends Azure credit).
// Best-effort: any failure is swallowed so a memory hiccup never breaks a chat.

import { fetchPersonaMemory, upsertPersonaMemory } from './supabase.mjs';
import { chatCompleteFailover } from './llm-providers.mjs';

function memorySystem(personaName) {
    const name = String(personaName || 'this character').trim() || 'this character';
    return [
        `You maintain a private, evolving MEMORY that the AI character "${name}" keeps about ONE person they talk to — who that person is, and the history between them.`,
        'You are given the CURRENT memory and the latest exchange. Produce an UPDATED memory so the character can talk like someone who genuinely remembers this person.',
        '',
        'Capture ONLY what the evidence supports:',
        '- Who the person is: name, what they are into, what is going on with them.',
        `- The relationship + history with ${name}: running jokes, things shared, promises made, recurring topics, how they relate.`,
        '- Threads to follow up on next time.',
        '',
        'RULES:',
        '- MERGE: keep everything still true, fold in the new, refine where needed. Never drop important details.',
        '- Be concise: UNDER 900 characters, plain text, short lines. No headings, no preamble, no fluff.',
        '- NEVER invent anything not actually revealed. If a turn adds nothing new, return the current memory essentially unchanged.',
        '- Write the memory in English (it is internal context), regardless of the chat language.',
        '- Output ONLY the updated memory text — nothing else.',
    ].join('\n');
}

/**
 * Merge one exchange into this persona's memory of the user. Never throws.
 * @param {string} userId
 * @param {string} personaId
 * @param {string} personaName
 * @param {{userText:string, assistantText?:string}} evt
 */
export async function updatePersonaMemory(userId, personaId, personaName, { userText, assistantText } = {}) {
    if (!userId || !personaId || !userText) return;
    try {
        const current = (await fetchPersonaMemory(userId, personaId).catch(() => '')) || '(none yet)';
        const name = String(personaName || 'the character').trim() || 'the character';

        const userMsg =
            `CURRENT MEMORY:\n${current}\n\n` +
            `LATEST EXCHANGE:\n` +
            `Person: ${String(userText).slice(0, 1500)}\n` +
            `${name}: ${String(assistantText || '').slice(0, 1500)}\n\n` +
            `Output the updated memory now.`;

        const out = await chatCompleteFailover(
            [
                { role: 'system', content: memorySystem(personaName) },
                { role: 'user',   content: userMsg },
            ],
            { temperature: 0.3, maxTokens: 400, timeoutMs: 15000, tier: 'cheap' }
        );

        const memory = (out.text || '').trim();
        if (memory.length > 5) await upsertPersonaMemory(userId, personaId, memory.slice(0, 4000));
    } catch (e) {
        console.warn(`[persona-memory] updatePersonaMemory failed for ${userId}/${personaId}: ${e.message}`);
    }
}
