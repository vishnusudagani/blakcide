// Shared Brain — vibe state read/write.
//
// Every interaction (chat turn, call end, journal save, proactive ping) calls:
//   1. getVibe(userId)          → tiny snapshot to inject into the prompt
//   2. recordEvent(userId, evt) → appends a delta + recomputes the live state
//
// The classifier runs as a background sub-call so it never blocks user-facing
// latency. Cost: ~1 cent per 200 turns.
//
// Snapshot shape (what callers inject into prompts):
//   "Current vibe: anxiety 0.72, energy 30/100, lane=romanized-te, topic=exam stress, low-streak 2d"
// Keep it under 80 tokens so it's cheap to ship every turn.

import {
    fetchVibeState, upsertVibeState, insertVibeEvent,
} from './supabase.mjs';

// Decay constant for vibe score: a delta from 24h ago has ~50% influence.
// We don't actually decay rows in storage — we only rebuild the live state
// from the most recent event + a clamped roll-up of recent_low_days.
const VIBE_CLAMP_LOW  = -100;
const VIBE_CLAMP_HIGH =  100;

// ── Public read ────────────────────────────────────────────────────────────

/**
 * Get the live vibe row for a user. Never throws — returns a zero-state
 * snapshot if the row doesn't exist or fetch fails.
 *
 * Shape:
 *   {
 *     vibe_score, energy, primary_emotion, language_lane,
 *     last_topic, consecutive_low_days, streak_days, updated_at, fresh
 *   }
 *
 * `fresh: false` means we returned a default — caller can choose to skip
 * injecting the snapshot to keep the prompt lean for new users.
 */
export async function getVibe(userId) {
    if (!userId) return defaultVibe(false);
    try {
        const row = await fetchVibeState(userId);
        if (!row) return defaultVibe(false);
        return { ...row, fresh: true };
    } catch (e) {
        console.warn(`[vibe-tracker] getVibe(${userId}) failed: ${e.message}`);
        return defaultVibe(false);
    }
}

function defaultVibe(fresh) {
    return {
        vibe_score:           0,
        energy:               50,
        primary_emotion:      'calm',
        language_lane:        'en',
        last_topic:           null,
        consecutive_low_days: 0,
        streak_days:          0,
        updated_at:           null,
        fresh,
    };
}

// ── Snapshot text for prompt injection ─────────────────────────────────────

/**
 * Render the vibe row as a tiny system-prompt fragment. Returns '' if the
 * row is fresh-default so we don't waste tokens on a brand-new user.
 */
export function renderVibeSnapshot(vibe) {
    if (!vibe || !vibe.fresh) return '';
    const parts = [];
    parts.push(`emotion=${vibe.primary_emotion}`);
    parts.push(`score=${vibe.vibe_score}`);
    parts.push(`energy=${vibe.energy}/100`);
    parts.push(`lane=${vibe.language_lane}`);
    if (vibe.last_topic)            parts.push(`topic="${String(vibe.last_topic).slice(0, 60)}"`);
    if (vibe.consecutive_low_days)  parts.push(`low-days=${vibe.consecutive_low_days}`);
    if (vibe.streak_days)           parts.push(`streak=${vibe.streak_days}d`);
    return [
        '=== CURRENT USER VIBE (internal — do NOT mention these labels to the user) ===',
        parts.join(' · '),
        '=== END VIBE ===',
    ].join('\n');
}

// ── Classifier (async, never blocks) ───────────────────────────────────────

const CLASSIFIER_MODEL = 'gpt-4o-mini';

/**
 * Build the classifier prompt — one-shot JSON-mode call that emits a delta
 * AND a normalised next-state. We ask for both because the model is better
 * at producing absolute "where they are now" than relative "what changed".
 *
 * The classifier sees:
 *   - The current vibe state (so it can produce a smooth transition)
 *   - The new evidence (last few user turns, transcript, journal text)
 */
function buildClassifierPrompt({ source, currentVibe, evidence }) {
    return [
        'You are a real-time emotion + language classifier for a digital companion.',
        'Given the user\'s current vibe state and new evidence from a single interaction,',
        'output the user\'s NEW vibe as a strict JSON object — nothing else.',
        '',
        'JSON schema:',
        '  {',
        '    "vibe_score":      integer in [-100,100],   // negative = distress',
        '    "energy":          integer in [0,100],',
        '    "primary_emotion": "joy"|"sadness"|"anxiety"|"anger"|"calm"|"hopeful"|"numb"|"excited"|"tired"|"frustrated",',
        '    "language_lane":   "te"|"hi"|"en"|"romanized-te"|"romanized-hi",',
        '    "last_topic":      short string ≤60 chars in English (always),',
        '    "delta_score":     integer in [-50,50]      // change from current state',
        '  }',
        '',
        'Rules:',
        '- DO NOT swing more than 50 points from the current state in a single update.',
        '- For language_lane, use what the USER spoke/wrote, not what the AI said back.',
        '- For brand-new users (current_vibe.score=0, energy=50), be conservative.',
        '',
        `Source: ${source}`,
        `Current vibe state: ${JSON.stringify(currentVibe)}`,
        '',
        'Evidence from this interaction:',
        evidence,
    ].join('\n');
}

/**
 * Internal: run the classifier. Returns a normalised delta object or null
 * on failure. NEVER throws.
 */
async function classify({ source, currentVibe, evidence }) {
    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) return null;
    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({
                model:           CLASSIFIER_MODEL,
                messages: [
                    { role: 'system', content: buildClassifierPrompt({ source, currentVibe, evidence }) },
                    { role: 'user',   content: 'Output the JSON now.' },
                ],
                temperature:     0.2,
                max_tokens:      200,
                response_format: { type: 'json_object' },
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            console.warn(`[vibe-tracker] classifier ${res.status}`);
            return null;
        }
        const data = await res.json();
        const txt  = data?.choices?.[0]?.message?.content || '';
        const obj  = JSON.parse(txt);
        return normaliseClassifierOutput(obj, currentVibe);
    } catch (e) {
        console.warn(`[vibe-tracker] classifier failed: ${e.message}`);
        return null;
    }
}

function normaliseClassifierOutput(obj, currentVibe) {
    const validEmotions = ['joy','sadness','anxiety','anger','calm','hopeful','numb','excited','tired','frustrated'];
    const validLanes    = ['te','hi','en','romanized-te','romanized-hi'];

    const vibe_score = clamp(int(obj.vibe_score, currentVibe.vibe_score), VIBE_CLAMP_LOW, VIBE_CLAMP_HIGH);
    const energy     = clamp(int(obj.energy, currentVibe.energy), 0, 100);
    const emotion    = validEmotions.includes(obj.primary_emotion) ? obj.primary_emotion : currentVibe.primary_emotion;
    const lane       = validLanes.includes(obj.language_lane) ? obj.language_lane : currentVibe.language_lane;
    const topic      = obj.last_topic ? String(obj.last_topic).slice(0, 60) : currentVibe.last_topic;
    const delta      = clamp(int(obj.delta_score, vibe_score - currentVibe.vibe_score), -50, 50);

    return {
        vibe_score,
        energy,
        primary_emotion: emotion,
        language_lane:   lane,
        last_topic:      topic,
        delta_score:     delta,
    };
}

function int(v, fallback)       { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; }
function clamp(n, lo, hi)       { return Math.max(lo, Math.min(hi, n)); }

// ── Public write ───────────────────────────────────────────────────────────

/**
 * Record a vibe event. Runs the classifier, writes the new state + appends
 * an event row. Designed to be called WITHOUT awaiting from request handlers
 * — it's safe to "fire and forget" since it never throws.
 *
 * @param {string} userId
 * @param {Object} evt
 * @param {'ai_chat'|'ai_call'|'human_chat'|'human_call'|'journal'|'proactive'} evt.source
 * @param {string} [evt.sourceSessionId]
 * @param {string} evt.evidence    // free-text excerpt for the classifier
 */
export async function recordEvent(userId, evt) {
    if (!userId || !evt || !evt.evidence) return;
    try {
        const current = await getVibe(userId);
        const cls = await classify({
            source:      evt.source,
            currentVibe: current,
            evidence:    String(evt.evidence).slice(0, 4000),
        });
        if (!cls) return;

        // Roll-up: consecutive_low_days bumps if today has any negative event,
        // resets if vibe_score crosses back above 0.
        const today      = new Date().toISOString().slice(0, 10);
        const lastUpdate = current.updated_at ? new Date(current.updated_at).toISOString().slice(0, 10) : null;
        const isNewDay   = lastUpdate && lastUpdate !== today;

        let consecutiveLow = current.consecutive_low_days || 0;
        if (cls.vibe_score < -20) {
            consecutiveLow = isNewDay ? consecutiveLow + 1 : Math.max(consecutiveLow, 1);
        } else if (cls.vibe_score >= 0) {
            consecutiveLow = 0;
        }

        let streak = current.streak_days || 0;
        streak = isNewDay ? streak + 1 : Math.max(streak, 1);

        const nextState = {
            user_id:              userId,
            vibe_score:           cls.vibe_score,
            energy:               cls.energy,
            primary_emotion:      cls.primary_emotion,
            language_lane:        cls.language_lane,
            last_topic:           cls.last_topic,
            consecutive_low_days: consecutiveLow,
            streak_days:          streak,
        };

        // Insert event first so we have its id to link as source_event_id.
        const eventId = await insertVibeEvent({
            userId,
            source:           evt.source,
            sourceSessionId:  evt.sourceSessionId || null,
            vibeDelta:        { delta_score: cls.delta_score, primary_emotion: cls.primary_emotion, energy: cls.energy, language_lane: cls.language_lane },
            vibeSnapshot:     nextState,
        }).catch(() => null);

        await upsertVibeState({ ...nextState, source_event_id: eventId });
    } catch (e) {
        console.warn(`[vibe-tracker] recordEvent failed for ${userId}: ${e.message}`);
    }
}

/**
 * Fire-and-forget version — schedules the work without awaiting it. Use
 * this from request handlers to avoid latency penalty.
 */
export function recordEventAsync(userId, evt) {
    // queueMicrotask so we still let the current handler return its response,
    // but the work runs in the same Lambda invocation (Netlify keeps it warm
    // long enough for sub-calls of this size).
    queueMicrotask(() => { recordEvent(userId, evt); });
}
