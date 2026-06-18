// Rolling user-memory updater — the "Blak learns about you" engine.
//
// After each chat turn (fire-and-forget, never blocks the reply), we merge the
// latest exchange into a concise, evolving profile stored in
// profiles.user_memory. vault-context.mjs injects that memory into every future
// chat + call, so Blak keeps getting to know the user across sessions and
// surfaces (cross-context: text ↔ voice ↔ journal all read the same memory).
//
// Cost: routed through inference.mjs → the FREE Groq floor (background work
// never spends the Azure credit). Best-effort: any failure is swallowed so a
// memory hiccup can never break a conversation.

import { fetchBlaksydProfile, updateUserMemory } from './supabase.mjs';
// Failover (Groq-first → OSS → Azure) so a Groq rate-limit doesn't drop the memory update.
import { chatCompleteFailover } from './llm-providers.mjs';

const MEMORY_SYSTEM = [
    'You maintain a private, evolving MEMORY of a user for their AI friend "Blak".',
    'You are given the CURRENT memory and the latest message exchange. Produce an UPDATED memory:',
    'a concise, factual profile of who this user is and what matters to them, so Blak can be a',
    'friend who genuinely remembers them across conversations.',
    '',
    'Capture ONLY what the evidence supports — across the whole memory:',
    '- Basics: name, age, location, work/study.',
    '- Key people in their life (names + relationship).',
    '- What they care about: goals, values, worries, what they\'re going through.',
    '- Preferences: the language(s) they use, interests, how they like to talk.',
    '- Ongoing threads: current situations, plans, things to follow up on.',
    '- Recurring emotional patterns or needs.',
    '',
    'RULES:',
    '- MERGE: keep everything still true from CURRENT memory, fold in new facts, refine/correct where needed. Never drop important details.',
    '- Be concise: UNDER 900 characters, plain text (short lines). No headings, no preamble, no fluff.',
    '- NEVER invent anything the user did not actually reveal. If a turn adds nothing new, return the current memory essentially unchanged.',
    '- Write the memory in English (it is internal context), regardless of the chat language.',
    '- Output ONLY the updated memory text — nothing else.',
].join('\n');

/**
 * Merge one exchange into the user's rolling memory. Never throws.
 * @param {string} userId
 * @param {{userText:string, assistantText?:string}} evt
 */
export async function updateRollingMemory(userId, { userText, assistantText } = {}) {
    if (!userId || !userText) return;
    try {
        const profile = await fetchBlaksydProfile(userId).catch(() => null);
        const current = (profile && profile.user_memory) ? profile.user_memory : '(none yet)';

        const userMsg =
            `CURRENT MEMORY:\n${current}\n\n` +
            `LATEST EXCHANGE:\n` +
            `User: ${String(userText).slice(0, 1500)}\n` +
            `Blak: ${String(assistantText || '').slice(0, 1500)}\n\n` +
            `Output the updated memory now.`;

        const out = await chatCompleteFailover(
            [
                { role: 'system', content: MEMORY_SYSTEM },
                { role: 'user',   content: userMsg },
            ],
            { temperature: 0.3, maxTokens: 400, timeoutMs: 15000, tier: 'cheap' }
        );

        const memory = (out.text || '').trim();
        if (memory.length > 5) {
            await updateUserMemory(userId, memory.slice(0, 4000));
        }
    } catch (e) {
        console.warn(`[memory-updater] updateRollingMemory failed for ${userId}: ${e.message}`);
    }
}

/**
 * Fire-and-forget — schedule the memory update without blocking the handler's
 * response (same pattern as vibe-tracker.recordEventAsync).
 */
export function updateRollingMemoryAsync(userId, evt) {
    queueMicrotask(() => { updateRollingMemory(userId, evt); });
}
