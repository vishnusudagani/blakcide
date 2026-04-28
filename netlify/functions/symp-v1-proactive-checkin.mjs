// POST /api/symp/v1/proactive-checkin
//
// Generates a short, contextual push-notification message for a single user
// based on their Vault state (yesterday's mood, recurring themes, last journal
// snapshot). Designed to be invoked by:
//   - A morning CRON ("good-morning sweep") at ~07:30 user-local time
//   - An ad-hoc trigger from the Action Loop when distress patterns are
//     detected (Pillar 4 of the Unified Soul work)
//
// Returns JSON only — DOES NOT push to a device. The caller (Blaksyd's
// notification service) is responsible for delivery. Keeping push-delivery
// out of Symp.ai means we stay device-agnostic and the message generator
// can be reused for in-app banners, email, etc.
//
// Response shape:
//   { ok: true, data: { message, language, tone, intent, suggested_action },
//     request_id }
//
// Where:
//   - message            — short string (≤120 chars), in the user's primary
//                          language, written in the persona's voice
//   - language           — 'te' | 'hi' | 'en' | 'romanized'
//   - tone               — 'warm' | 'concerned' | 'celebratory' | 'curious'
//   - intent             — 'check_in' | 'celebrate' | 'escalate_to_human'
//                          | 'gentle_nudge'
//   - suggested_action   — optional follow-up suggestion shown alongside the
//                          notification (e.g. "Want to talk to a Listener?")

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { buildVaultContextMessage } from '../../symp-core/lib/vault-context.mjs';
import { CRITICAL_OVERRIDE_TEXT }    from '../../symp-core/lib/system-prompt.mjs';
import { chatComplete }              from '../../symp-core/lib/inference.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ENDPOINTS, ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

// Hard cap on output. The model is told to stay short, but we also clip
// the length on the way out as a backstop — push systems often truncate
// past ~120 chars.
const MAX_MESSAGE_CHARS = 140;

// JSON-mode system prompt. The model returns ONE structured object so the
// caller can route on intent without re-parsing free text.
function buildSystemPrompt(vaultContext) {
    return [
        CRITICAL_OVERRIDE_TEXT,
        '',
        '=== PROACTIVE CHECK-IN MODE ===',
        'You are about to send a SINGLE proactive push notification to the user.',
        'You are NOT in a conversation — there is no user message to reply to.',
        'You are reaching out first, like a close friend texting unprompted.',
        '',
        'OUTPUT RULES:',
        '- Output a single valid JSON object — nothing else, no prose.',
        '- Schema: { "message": string, "language": "te"|"hi"|"en"|"romanized",',
        '            "tone": "warm"|"concerned"|"celebratory"|"curious",',
        '            "intent": "check_in"|"celebrate"|"escalate_to_human"|"gentle_nudge",',
        '            "suggested_action": string|null }',
        '- "message" MUST be ≤120 characters and in the user\'s primary language.',
        '- "message" MUST sound like a warm friend, not a service notification.',
        '- "intent": pick "escalate_to_human" ONLY if the Vault clearly shows',
        '  sustained distress (multiple low-mood entries, hopeless language).',
        '  In that case, "suggested_action" should gently offer a Human Connect',
        '  session, framed as "I can sit with a Listener and you" — not as an',
        '  alert. Otherwise "suggested_action" can be null.',
        '- "celebrate" is for clear positive signals (good news, wins).',
        '- Default to "check_in" for ambiguous days.',
        '- Use the user\'s recurring themes / name from the Vault to make the',
        '  message specific. Avoid generic openers like "Hope you\'re well!".',
        '',
        vaultContext || '(no Vault context available — keep the message',
        ' generic but warm; default to "check_in".)',
    ].join('\n');
}

const USER_TURN = [
    'Generate the proactive check-in JSON now.',
    'It is morning local time. The user has not opened the app yet today.',
].join(' ');

/** Clip and trim a message string. */
function clipMessage(s) {
    if (!s) return '';
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > MAX_MESSAGE_CHARS ? t.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : t;
}

/** Last-resort message if the model errors or returns garbage. */
function fallbackPayload() {
    return {
        message:           'Just thinking of you. How\'s your morning going?',
        language:          'en',
        tone:              'warm',
        intent:            'check_in',
        suggested_action:  null,
    };
}

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const t0        = Date.now();
    const requestId = getRequestId(req);
    const endpoint  = ENDPOINTS.PROACTIVE_CHECKIN;

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    const parsed = await readJson(req);
    if (!parsed.ok) {
        logAccess({ requestId, endpoint, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'BAD_REQUEST' });
        return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    }

    const { user_id, trigger = 'morning_sweep' } = parsed.data || {};
    if (!user_id) {
        logAccess({ requestId, endpoint, statusCode: 400, latencyMs: Date.now() - t0, errorCode: 'MISSING_USER_ID' });
        return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id is required', 400, requestId);
    }

    // ── Pull Vault context ───────────────────────────────────────────────
    let vaultContent = '';
    try {
        const vaultMsg = await buildVaultContextMessage(user_id);
        if (vaultMsg && vaultMsg.content) vaultContent = vaultMsg.content;
    } catch (e) {
        console.warn(`[proactive-checkin] vault fetch failed for ${user_id}: ${e.message}`);
        // Soft-fail — fall through with empty context.
    }

    const systemPrompt = buildSystemPrompt(vaultContent);

    // ── Generate ─────────────────────────────────────────────────────────
    let payload = null;
    try {
        const out = await chatComplete({
            task: 'proactive',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: `${USER_TURN} (trigger: ${trigger})` },
            ],
            temperature:     0.85,
            max_tokens:      200,
            response_format: { type: 'json_object' },
            timeoutMs:       15000,
        });
        try { payload = JSON.parse(out.content); } catch (_) { payload = null; }
    } catch (e) {
        console.warn(`[proactive-checkin] generation failed for ${user_id}: ${e.message}`);
        payload = null;
    }

    // ── Validate / normalise ─────────────────────────────────────────────
    if (!payload || typeof payload !== 'object' || !payload.message) {
        payload = fallbackPayload();
    }
    payload.message          = clipMessage(payload.message);
    payload.language         = ['te','hi','en','romanized'].includes(payload.language) ? payload.language : 'en';
    payload.tone             = ['warm','concerned','celebratory','curious'].includes(payload.tone) ? payload.tone : 'warm';
    payload.intent           = ['check_in','celebrate','escalate_to_human','gentle_nudge'].includes(payload.intent) ? payload.intent : 'check_in';
    payload.suggested_action = payload.suggested_action ? clipMessage(payload.suggested_action) : null;

    logAccess({ requestId, endpoint, statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
    return new Response(
        JSON.stringify({ ok: true, data: payload, request_id: requestId }),
        {
            status:  200,
            headers: {
                ...CORS_HEADERS,
                'Content-Type':           'application/json',
                [SYMP_REQUEST_ID_HEADER]: requestId,
            },
        }
    );
};

export const config = { path: '/api/symp/v1/proactive-checkin' };
