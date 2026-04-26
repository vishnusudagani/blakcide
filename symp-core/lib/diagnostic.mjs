// Module 5 — Self-Correcting Logic Engine.
//
// Runs *after* every model turn (chat or voice transcript). It looks for two
// classes of regression and emits corrective hints that get spliced into the
// next system stack:
//
//   1. LANGUAGE DRIFT
//      The user spoke in lane X but the model replied in lane Y.
//      → emit a "PREVIOUS TURN ALERT" line so the very next reply snaps back.
//
//   2. VAD INTERRUPT FATIGUE  (voice only)
//      The user keeps cutting the model off mid-sentence.
//      → suggest a looser VAD profile (longer silence_duration_ms) and tell
//        the persona to keep replies shorter.
//
// COOLDOWN
//   Once a correction fires, we hold it for HOLD_TURNS turns before
//   reassessing — otherwise the model would oscillate on borderline cases.
//   State is kept in-process (Map keyed by userId). For multi-instance
//   deploys this is fine: each worker self-corrects independently and the
//   signal converges within a few turns.
//
// We also push every signal into symp_vibe_events with source='diagnostic'
// so it shows up in the post-mortem analyser without inflating the vibe
// score (delta=0).

import { insertVibeEvent } from './supabase.mjs';

// ── Tunables ───────────────────────────────────────────────────────────────
const HOLD_TURNS                = 3;     // turns a correction stays "pinned"
const INTERRUPT_WINDOW          = 5;     // look at the last N voice turns
const INTERRUPT_THRESHOLD       = 3;     // ≥3 interrupts in window → VAD hint
const VAD_RELAXED_SILENCE_MS    = 1800;  // bumped from 1200
const VAD_RELAXED_THRESHOLD     = 0.55;  // slightly lower (less eager to cut)

// Per-user diagnostic state. Cleared on process restart — that's fine.
const _state = new Map();

function _getState(userId) {
    let s = _state.get(userId);
    if (!s) {
        s = {
            interrupts: [],          // ring buffer of bool, last is most recent
            languagePin: null,       // { lane, ttl } — corrective hint
            vadPin:      null,       // { ttl } — relaxed VAD hint
        };
        _state.set(userId, s);
    }
    return s;
}

// ── Language detection ─────────────────────────────────────────────────────
// Lightweight heuristic — good enough to flag obvious drift. We don't try to
// be a proper language ID model; we just need "did the model reply in the
// same lane the user used?".

const RE_DEVANAGARI = /[\u0900-\u097F]/;
const RE_TELUGU     = /[\u0C00-\u0C7F]/;
const RE_TAMIL      = /[\u0B80-\u0BFF]/;
const RE_BENGALI    = /[\u0980-\u09FF]/;
const RE_KANNADA    = /[\u0C80-\u0CFF]/;
const RE_GURMUKHI   = /[\u0A00-\u0A7F]/;

// Romanized Indic markers — short tokens that almost never appear in plain
// English. Hit-rate over total alpha tokens decides romanized-XX vs en.
const ROMAN_MARKERS = {
    'romanized-te': ['cheppu','chesa','undi','ledu','kavalsi','ekkada','epudu','enti','vaadu','annaya','akka','chellem','nuvvu','meeru','manchidi','ayyo','baagunna','baagundi','telusu','kuda'],
    'romanized-hi': ['kya','hai','nahi','nahin','kaise','kaisi','kyun','kyon','tum','tumhe','aap','mujhe','mera','meri','tera','teri','accha','theek','bhai','behen','yaar','matlab','samajh','batao','karo','karna','hua','hogi','hoga'],
    'romanized-ta': ['enna','epdi','illa','irukku','ponga','vanga','romba','seri','thala','machan','dei','annan','akka','thambi','vendam','mudiyala'],
    'romanized-bn': ['ki','ache','keno','tumi','ami','tomar','amar','khub','bhalo','khoob','korbo','kortechi'],
};

/**
 * Detect language lane from a text sample.
 * Returns one of: 'en' | 'hi' | 'te' | 'ta' | 'bn' | 'kn' | 'pa'
 *               | 'romanized-hi' | 'romanized-te' | 'romanized-ta' | 'romanized-bn'
 *               | 'unknown'
 */
export function detectLane(text) {
    if (!text || typeof text !== 'string') return 'unknown';
    const sample = text.slice(0, 800);

    // Native scripts win immediately — no ambiguity.
    if (RE_DEVANAGARI.test(sample)) return 'hi';
    if (RE_TELUGU    .test(sample)) return 'te';
    if (RE_TAMIL     .test(sample)) return 'ta';
    if (RE_BENGALI   .test(sample)) return 'bn';
    if (RE_KANNADA   .test(sample)) return 'kn';
    if (RE_GURMUKHI  .test(sample)) return 'pa';

    // Latin script — score against romanized markers.
    const tokens = sample.toLowerCase().match(/[a-z']+/g) || [];
    if (tokens.length < 2) return 'unknown';

    let best = { lane: 'en', hits: 0 };
    for (const [lane, markers] of Object.entries(ROMAN_MARKERS)) {
        const set = new Set(markers);
        let hits = 0;
        for (const tok of tokens) if (set.has(tok)) hits++;
        if (hits > best.hits) best = { lane, hits };
    }
    // Need at least 2 marker hits OR ≥10% of tokens to claim romanized lane;
    // otherwise treat as plain English.
    if (best.hits >= 2 || best.hits / tokens.length >= 0.1) return best.lane;
    return 'en';
}

/**
 * Two lanes are "compatible" if a reply in one is acceptable for the other.
 * - Native-script lanes are strict: te must reply te, hi must reply hi.
 * - Romanized lanes are also strict — romanized-te user wants romanized-te
 *   back (writing Telugu script in WhatsApp-style chat is awkward).
 * - 'unknown' matches anything (don't flag drift on garbage input).
 */
function lanesCompatible(userLane, modelLane) {
    if (userLane === 'unknown' || modelLane === 'unknown') return true;
    if (userLane === modelLane) return true;
    // Treat english + short replies as compatible (one-word "ok" etc.).
    return false;
}

// ── Public analysis ────────────────────────────────────────────────────────

/**
 * Analyse a single turn. Cheap & synchronous — caller may run it in the
 * post-stream cleanup without blocking anything.
 *
 * @param {Object} turn
 * @param {string} turn.userId
 * @param {string} turn.userText      — what the user just said
 * @param {string} turn.modelText     — what the model replied
 * @param {boolean} [turn.wasInterrupted] — voice only: did user cut model off
 * @param {string} [turn.surface]     — 'voice' | 'chat'  (default 'chat')
 *
 * @returns {Object} { signals: string[], pinned: { language, vad } }
 *   signals — human-readable lines we wrote to vibe_events
 *   pinned  — current corrections (consumed by buildCorrectionHint())
 */
export function analyseTurn({ userId, userText, modelText, wasInterrupted = false, surface = 'chat' }) {
    if (!userId) return { signals: [], pinned: { language: null, vad: null } };
    const s = _getState(userId);
    const signals = [];

    // ── 1. Language drift ─────────────────────────────────────────────
    const userLane  = detectLane(userText);
    const modelLane = detectLane(modelText);
    if (!lanesCompatible(userLane, modelLane)) {
        // Pin a correction for HOLD_TURNS turns.
        s.languagePin = { userLane, modelLane, ttl: HOLD_TURNS };
        signals.push(`language_drift: user=${userLane} model=${modelLane}`);
    } else if (s.languagePin) {
        s.languagePin.ttl -= 1;
        if (s.languagePin.ttl <= 0) s.languagePin = null;
    }

    // ── 2. Interrupt fatigue (voice only) ─────────────────────────────
    if (surface === 'voice') {
        s.interrupts.push(!!wasInterrupted);
        if (s.interrupts.length > INTERRUPT_WINDOW) s.interrupts.shift();
        const recentCount = s.interrupts.filter(Boolean).length;
        if (recentCount >= INTERRUPT_THRESHOLD) {
            s.vadPin = { ttl: HOLD_TURNS };
            signals.push(`vad_interrupt_fatigue: ${recentCount}/${s.interrupts.length}`);
        } else if (s.vadPin) {
            s.vadPin.ttl -= 1;
            if (s.vadPin.ttl <= 0) s.vadPin = null;
        }
    }

    // Fire-and-forget vibe event so the analyser/listener has a record.
    if (signals.length) {
        const evidence = signals.join(' | ');
        queueMicrotask(() => {
            insertVibeEvent({
                user_id:    userId,
                source:     'diagnostic',
                delta:      0,                // never moves vibe score
                evidence,
            }).catch(() => { /* swallow — diagnostic is best-effort */ });
        });
    }

    return {
        signals,
        pinned: {
            language: s.languagePin ? { ...s.languagePin } : null,
            vad:      s.vadPin      ? { ...s.vadPin }      : null,
        },
    };
}

/**
 * Render the pinned correction hints as a single system-prompt line. Splice
 * this into the system stack on the *next* turn (chat-runner does this
 * automatically; voice clients should fetch via /diagnostic/peek before
 * their next session.update).
 *
 * Returns '' when there is nothing to inject.
 */
export function buildCorrectionHint(userId) {
    const s = _state.get(userId);
    if (!s) return '';
    const parts = [];

    if (s.languagePin) {
        const { userLane, modelLane } = s.languagePin;
        parts.push(
            `PREVIOUS TURN ALERT: You replied in lane '${modelLane}' but the user spoke in '${userLane}'. ` +
            `Snap back immediately — your next reply MUST be in '${userLane}'. No exceptions, no apology, just switch.`
        );
    }
    if (s.vadPin) {
        parts.push(
            `INTERRUPT FATIGUE: The user has cut you off ${INTERRUPT_THRESHOLD}+ times recently. ` +
            `Speak in shorter beats — one or two sentences max — and pause naturally so they can jump in.`
        );
    }
    if (!parts.length) return '';

    return ['# 7. SELF-CORRECTION', ...parts].join('\n\n');
}

/**
 * Read-only snapshot of the active VAD recommendation. Voice clients call
 * this through /diagnostic/peek and feed the result into session.update.
 * Returns null if no override is active (client should keep defaults).
 */
export function peekVadOverride(userId) {
    const s = _state.get(userId);
    if (!s || !s.vadPin) return null;
    return {
        type:                'server_vad',
        threshold:            VAD_RELAXED_THRESHOLD,
        prefix_padding_ms:    300,
        silence_duration_ms:  VAD_RELAXED_SILENCE_MS,
    };
}

/**
 * Test-only: clear all in-process diagnostic state. Not exported via the
 * HTTP layer.
 */
export function _resetForTests(userId) {
    if (userId) _state.delete(userId);
    else _state.clear();
}
