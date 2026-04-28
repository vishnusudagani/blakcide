// POST /api/symp/v1/copilot/hint
//
// Module 1 (Live Co-Pilot) — "The Whisperer".
//
// A human listener's UI calls this during an active session. It returns a
// short, private hint grounded in:
//   1. The seeker's symp_vault_profiles.symp_analysis (Module 4 output)
//   2. Their last 3–4 daily journals (recent patterns)
//   3. The recent message turns from the live session
//
// IMPORTANT: target_user_id is the SEEKER, not the listener. The proxy stamps
// req.user_id with the listener's authenticated id (so logging knows who
// asked), but the Vault read uses target_user_id passed in the body.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError,
    readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import {
    fetchVaultProfile, fetchRecentJournals, fetchBlaksydProfile,
} from '../../symp-core/lib/supabase.mjs';
import { chatComplete, InferenceError } from '../../symp-core/lib/inference.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES } = SympContract;

const SYSTEM_PROMPT = `You are the Co-Pilot — a private assistant whispering to a
human listener during a live mental-wellness session. The seeker NEVER sees
your output. The listener uses your hint to choose how to respond next.

Your output rules:
- One short paragraph (≤ 50 words) OR up to 3 bullet points (≤ 15 words each).
- Reference one specific thing from the seeker's profile/analysis when possible
  (e.g. "they mentioned work stress yesterday" / "watch for the avoidance pattern").
- Suggest a tone or a single open-ended question the listener can ask — never
  a script to recite verbatim.
- If the live transcript shows distress / crisis cues, lead with that and tell
  the listener to slow down and check in directly.
- Never diagnose. Never pretend to know things the profile doesn't say.
- If the profile is empty / new user, say so plainly and suggest a gentle
  open-ended check-in.`;

function fmtAnalysis(an) {
    if (!an || typeof an !== 'object') return '(no analysis yet)';
    const moods = Array.isArray(an.moods)
        ? an.moods.map(m => `${m.label}(${m.intensity || '?'})`).join(', ')
        : '';
    const themes = Array.isArray(an.themes) ? an.themes.join(', ') : '';
    const stress = Array.isArray(an.stress_signals) ? an.stress_signals.join(', ') : '';
    const focus  = an.recommended_focus || '';
    const risk   = an.risk_level || 'low';
    return [
        moods ? `Moods: ${moods}` : null,
        themes ? `Themes: ${themes}` : null,
        stress ? `Stress signals: ${stress}` : null,
        focus  ? `Recommended focus: ${focus}` : null,
        `Risk level: ${risk}`,
        an.summary ? `Day summary: ${an.summary}` : null,
        an._analysed_for ? `Analysed for: ${an._analysed_for}` : null,
    ].filter(Boolean).join('\n');
}

function fmtJournals(rows) {
    if (!Array.isArray(rows) || !rows.length) return '(no recent journals)';
    return rows.slice(0, 4).map(r => {
        const tag = r.entry_type === 'human_connect' ? 'HumanConnect' : 'AICompanion';
        const txt = (r.summary_content || '').slice(0, 220).replace(/\s+/g, ' ').trim();
        return `[${r.journal_date} · ${tag}] ${txt}`;
    }).join('\n');
}

function fmtTranscript(msgs) {
    if (!Array.isArray(msgs) || !msgs.length) return '(no messages yet — session just started)';
    return msgs.slice(-12).map(m => {
        const who = m.role === 'listener' || m.role === 'assistant' ? 'Listener' : 'Seeker';
        return `${who}: ${(m.content || '').slice(0, 240)}`;
    }).join('\n');
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: ENDPOINTS.COPILOT_HINT, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);

    const {
        user_id,                 // listener (set by proxy from JWT)
        target_user_id,          // seeker — whose Vault to read
        session_id,
        recent_messages,
        listener_question,
    } = parsed.data || {};

    if (!target_user_id) {
        return jsonError(ERROR_CODES.BAD_REQUEST, 'target_user_id (seeker) is required', 400, requestId);
    }

    // ── Pull Vault context for the seeker ────────────────────────────────────
    let vault, journals, blaksydProfile;
    try {
        [vault, journals, blaksydProfile] = await Promise.all([
            fetchVaultProfile(target_user_id).catch(() => null),
            fetchRecentJournals(target_user_id, 4).catch(() => []),
            fetchBlaksydProfile(target_user_id).catch(() => null),
        ]);
    } catch (e) {
        logAccess({ requestId, endpoint: ENDPOINTS.COPILOT_HINT, statusCode: 500, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `Vault read failed: ${e.message || e}`, 500, requestId);
    }

    const userBlock = blaksydProfile
        ? [
            blaksydProfile.full_name ? `Name: ${blaksydProfile.full_name}` : null,
            blaksydProfile.bio       ? `Bio: ${blaksydProfile.bio.slice(0, 200)}` : null,
            blaksydProfile.user_memory ? `Memory notes: ${blaksydProfile.user_memory.slice(0, 400)}` : null,
        ].filter(Boolean).join('\n')
        : '(no Blaksyd profile)';

    const userMsg = [
        '── Seeker profile ──',
        userBlock,
        '',
        '── Latest Symp.ai analysis ──',
        fmtAnalysis(vault?.symp_analysis),
        '',
        '── Recent daily journals (most recent first) ──',
        fmtJournals(journals),
        '',
        '── Live session transcript (last turns) ──',
        fmtTranscript(recent_messages),
        '',
        listener_question
            ? `── Listener's specific ask ──\n${String(listener_question).slice(0, 400)}`
            : '── Listener has no specific ask — give a default next-step hint. ──',
    ].join('\n');

    // ── Generate the hint ────────────────────────────────────────────────────
    let hint = '';
    try {
        const out = await chatComplete({
            task:        'hint',
            temperature: 0.55,
            max_tokens:  220,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: userMsg },
            ],
        });
        hint = out.content?.trim() || '';
    } catch (e) {
        const status = e instanceof InferenceError ? 502 : 500;
        const code   = e instanceof InferenceError ? ERROR_CODES.UPSTREAM_FAILED : ERROR_CODES.INTERNAL_ERROR;
        logAccess({ requestId, endpoint: ENDPOINTS.COPILOT_HINT, statusCode: status, latencyMs: Date.now() - t0, userId: user_id, errorCode: code });
        return jsonError(code, `Co-pilot fetch failed: ${e.message || e}`, status, requestId);
    }

    const risk = vault?.symp_analysis?.risk_level || 'low';

    logAccess({ requestId, endpoint: ENDPOINTS.COPILOT_HINT, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return jsonSuccess({
        hint,
        risk_level:    risk,
        used_analysis: !!vault?.symp_analysis,
        session_id:    session_id || null,
    }, requestId);
};

export const config = { path: '/api/symp/v1/copilot/hint' };
