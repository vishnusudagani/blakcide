// AI Whisperer — Listener co-pilot.
//
// Two surfaces:
//
//   buildBrief({ userId, listenerId, connectSessionId })
//       Generates a pre-session brief from the Vault and stores it in
//       symp_listener_briefs. Idempotent — returns the cached row on second
//       call. The brief is a short, structured JSON object designed to be
//       skimmed in <30 seconds before the Listener picks up.
//
//   buildVibeCheck({ userId, recentTurns })
//       Mid-session, called every ~30s by the whisper WS. Returns a tiny
//       "what to do RIGHT NOW" hint based on the last few exchanges +
//       current Vault vibe.
//
// Privacy contract:
//   - Briefs never include raw journal text. They include themes, vibe
//     summary, and short paraphrased "things they've mentioned".
//   - Briefs never include the user's full name unless the user has shared
//     it for use in Connect sessions (we only pass first-name when present).
//   - Vibe checks during a session are advisory only — the Listener always
//     decides what to say.

import { fetchBlaksydProfile, fetchVaultProfile, fetchRecentJournals,
         fetchVibeState, fetchListenerBrief, insertListenerBrief } from './supabase.mjs';
import { CRITICAL_OVERRIDE_TEXT } from './system-prompt.mjs';

const BRIEF_MODEL       = 'gpt-4o';
const VIBE_CHECK_MODEL  = 'gpt-4o-mini';

// ── Brief generator ───────────────────────────────────────────────────────

const BRIEF_SYSTEM = [
    'You are an expert clinical-style coach briefing a peer Listener before they connect with a person seeking support.',
    'You will receive: the user\'s profile snippet, their recent vibe state, recurring themes, and recent journal summaries.',
    'You output a single JSON object — nothing else. The Listener will read this in <30 seconds.',
    '',
    'Schema:',
    '  {',
    '    "summary":        string  ≤220 chars,        // who is this person right now',
    '    "current_vibe":   string  ≤100 chars,        // emotional state in plain language',
    '    "themes":         string[] (≤5, ≤30 chars each),',
    '    "do_say":         string[] (3 items, ≤80 chars each),',
    '    "dont_say":       string[] (3 items, ≤80 chars each),',
    '    "opening_line":   string  ≤120 chars,        // a warm, language-mirrored opener',
    '    "language_hint":  "te"|"hi"|"en"|"romanized-te"|"romanized-hi",',
    '    "risk_flags":     string[]  // e.g. ["sustained-low-mood-3d"], empty array if none',
    '  }',
    '',
    'Rules:',
    '- NEVER quote the user\'s journals verbatim. Paraphrase only.',
    '- NEVER include the user\'s last name or any contact details.',
    '- "opening_line" MUST be in the user\'s language lane and sound human, not scripted.',
    '- "risk_flags" MUST include "sustained-low-mood" if their current vibe shows multi-day distress, or "self-harm-language" only if present in evidence. Otherwise leave empty.',
    '- "do_say" / "dont_say" are practical: e.g. "Lead with: it sounds like work has been heavy" / "Avoid: instantly suggesting solutions".',
].join('\n');

function summariseEvidenceForBrief({ profile, vault, journals, vibe }) {
    const parts = [];
    if (profile?.full_name) parts.push(`First name (only): ${String(profile.full_name).split(' ')[0]}`);
    if (profile?.bio)       parts.push(`Bio (user-written): ${String(profile.bio).slice(0, 300)}`);

    if (vibe && vibe.updated_at) {
        parts.push(`Current vibe state: emotion=${vibe.primary_emotion}, score=${vibe.vibe_score}, energy=${vibe.energy}/100, lane=${vibe.language_lane}, low_days=${vibe.consecutive_low_days || 0}, last_topic="${vibe.last_topic || ''}"`);
    }

    if (vault?.symp_analysis) {
        const a = vault.symp_analysis;
        if (Array.isArray(a.key_themes)) parts.push(`Recurring themes: ${a.key_themes.slice(0, 8).join(', ')}`);
        if (a.psychology) parts.push(`Psych snapshot: ${JSON.stringify(a.psychology).slice(0, 400)}`);
    }

    if (Array.isArray(journals) && journals.length) {
        const compact = journals.slice(0, 6).map(j =>
            `[${j.journal_date}] ${(j.summary_content || '').slice(0, 220)}`
        );
        parts.push(`Recent journal summaries (paraphrase only, do NOT quote):\n${compact.join('\n')}`);
    }

    return parts.length ? parts.join('\n\n') : '(no Vault evidence — generate a generic warm brief)';
}

/**
 * Build (or fetch cached) Listener brief.
 * Returns the brief JSON. Throws on hard failures.
 */
// Synthesize the brief JSON from the user's Vault/profile (no listener/session,
// no persistence). Shared by buildBrief (listener-side, cached) and previewBrief
// (the user-side "see what Blak would share before you connect").
async function synthBrief(userId) {
    const [profile, vault, journals, vibe] = await Promise.all([
        fetchBlaksydProfile(userId).catch(() => null),
        fetchVaultProfile(userId).catch(() => null),
        fetchRecentJournals(userId, 10).catch(() => []),
        fetchVibeState(userId).catch(() => null),
    ]);

    const evidence = summariseEvidenceForBrief({ profile, vault, journals, vibe });

    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('No OpenAI key configured');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body:    JSON.stringify({
            model:           BRIEF_MODEL,
            messages: [
                { role: 'system', content: BRIEF_SYSTEM },
                { role: 'user',   content: evidence },
            ],
            temperature:     0.5,
            max_tokens:      500,
            response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Brief generation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const data = await res.json();
    let brief;
    try { brief = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); }
    catch (_) { brief = {}; }

    // Normalise / backstop.
    return {
        summary:       String(brief.summary || 'A user reaching out for support.').slice(0, 220),
        current_vibe:  String(brief.current_vibe || 'unknown').slice(0, 100),
        themes:        Array.isArray(brief.themes) ? brief.themes.slice(0, 5).map(t => String(t).slice(0, 30)) : [],
        do_say:        Array.isArray(brief.do_say) ? brief.do_say.slice(0, 3).map(t => String(t).slice(0, 80)) : [],
        dont_say:      Array.isArray(brief.dont_say) ? brief.dont_say.slice(0, 3).map(t => String(t).slice(0, 80)) : [],
        opening_line:  String(brief.opening_line || 'Hey, I\'m here. Take your time.').slice(0, 120),
        language_hint: ['te','hi','en','romanized-te','romanized-hi'].includes(brief.language_hint) ? brief.language_hint : (vibe?.language_lane || 'en'),
        risk_flags:    Array.isArray(brief.risk_flags) ? brief.risk_flags.slice(0, 6).map(t => String(t).slice(0, 40)) : [],
    };
}

export async function buildBrief({ userId, listenerId, connectSessionId, force = false }) {
    if (!userId || !listenerId || !connectSessionId) {
        throw new Error('buildBrief: userId, listenerId, connectSessionId required');
    }
    if (!force) {
        const cached = await fetchListenerBrief(connectSessionId).catch(() => null);
        if (cached?.brief) return cached.brief;
    }
    const brief = await synthBrief(userId);
    await insertListenerBrief({ connectSessionId, userId, listenerId, brief })
        .catch(e => console.warn(`[whisperer] insertListenerBrief failed: ${e.message}`));
    return brief;
}

// User-side preview: what Blak would brief a listener with, BEFORE connecting.
// No listener/session, nothing persisted — pure transparency ("context, not content").
export async function previewBrief(userId) {
    if (!userId) throw new Error('previewBrief: userId required');
    return synthBrief(userId);
}

// ── Vibe-check generator (mid-session) ────────────────────────────────────

const VIBE_CHECK_SYSTEM = [
    'You are a real-time co-pilot whispering to a peer Listener during a live support session.',
    'You will receive: the last few message exchanges + the user\'s current vibe state.',
    'You output ONE JSON object — nothing else.',
    '',
    'Schema:',
    '  {',
    '    "vibe_check":  string ≤80 chars,    // what just shifted, plain language',
    '    "priority":    "low"|"medium"|"high",',
    '    "suggestion":  string ≤100 chars,   // a non-prescriptive nudge for the Listener',
    '    "language_lane": "te"|"hi"|"en"|"romanized-te"|"romanized-hi"',
    '  }',
    '',
    'Rules:',
    '- "high" priority ONLY if you detect a self-harm cue or sudden severe drop.',
    '- "suggestion" should sound like a peer coach, not a script. Never put exact words in the Listener\'s mouth — suggest a DIRECTION.',
    '- If nothing meaningful shifted, return "vibe_check":"steady", priority "low", a brief encouragement.',
].join('\n');

/**
 * Build a vibe check for the live whisper WS. Returns the JSON object.
 * Soft-fails — returns null on error so the WS handler can drop the frame.
 */
export async function buildVibeCheck({ userId, recentTurns }) {
    if (!userId || !Array.isArray(recentTurns) || !recentTurns.length) return null;

    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) return null;

    const vibe = await fetchVibeState(userId).catch(() => null);

    const evidence = [
        vibe ? `Current vibe: emotion=${vibe.primary_emotion}, score=${vibe.vibe_score}, energy=${vibe.energy}, lane=${vibe.language_lane}` : 'Current vibe: unknown',
        '',
        'Recent turns (most recent last):',
        ...recentTurns.slice(-8).map(t => `${t.speaker}: ${String(t.text || '').slice(0, 240)}`),
    ].join('\n');

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body:    JSON.stringify({
                model:           VIBE_CHECK_MODEL,
                messages: [
                    { role: 'system', content: VIBE_CHECK_SYSTEM },
                    { role: 'user',   content: evidence },
                ],
                temperature:     0.3,
                max_tokens:      150,
                response_format: { type: 'json_object' },
            }),
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return null;
        const data    = await res.json();
        const content = data?.choices?.[0]?.message?.content || '{}';
        const obj     = JSON.parse(content);
        return {
            vibe_check:    String(obj.vibe_check || 'steady').slice(0, 80),
            priority:      ['low','medium','high'].includes(obj.priority) ? obj.priority : 'low',
            suggestion:    String(obj.suggestion || '').slice(0, 100),
            language_lane: ['te','hi','en','romanized-te','romanized-hi'].includes(obj.language_lane) ? obj.language_lane : (vibe?.language_lane || 'en'),
        };
    } catch (_) {
        return null;
    }
}
