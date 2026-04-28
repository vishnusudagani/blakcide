// TrendAnalyzer — detects emotional spikes and spawns time-boxed pop-up
// communities around them.
//
// Two pipelines:
//
//   A. Signal ingest. Wherever a vibe event lands (chat, voice, journal,
//      proactive checkin), the caller can also call `recordSignal` here
//      with a coarse theme key derived from the analyser's key_themes.
//      This is append-only, near-zero-cost, and fully decoupled from the
//      community side.
//
//   B. Hourly sweep. Reads the last 24h of signals, clusters by theme_key,
//      and for any theme that crosses the spike threshold AND doesn't
//      already have a live community, spawns a new ephemeral community
//      and seeds membership with the users whose vault embeddings rhyme
//      with the theme.
//
// We deliberately bias toward LOW-NOISE community creation. Most "themes"
// will not spawn a community on day one — the threshold is intentionally
// high so users only see relevant pop-ups, not a flood.

import {
    insertTrendSignal,
    listRecentTrendSignals,
    listNexusCommunities,
    fetchNexusCommunityBySlug,
    insertNexusCommunity,
    joinNexusCommunity,
    listActiveUsersForActionLoop,
    insertActionRow,
} from '../supabase.mjs';
import { ensureUserEmbedding, cosine, scoreToPercent } from './resonance.mjs';

// Tunables
const SPIKE_USER_THRESHOLD     = 8;       // distinct users on the theme in 24h
const SPIKE_WEIGHT_THRESHOLD   = 12;      // sum of signal weights in 24h
const SUGGEST_RESONANCE_FLOOR  = 0.35;    // cosine, ~67% percentage
const COMMUNITY_TTL_DAYS       = 7;
const SUGGEST_NOTIFY_LIMIT     = 50;      // notify at most N users per spawn

// Slugify — keep it ASCII, lowercase, dash-separated.
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

// ── A. Ingest ────────────────────────────────────────────────────────────

/**
 * Record a single signal. Themes are short snake_case keys
 * (e.g. 'exam_anxiety', 'breakup', 'job_search'). The label is the
 * user-facing string we'll use if a community spawns.
 */
export async function recordSignal({ userId, themeKey, themeLabel, weight = 1.0, evidence = {} }) {
    if (!themeKey) return false;
    return await insertTrendSignal({
        themeKey: slugify(themeKey).replace(/-/g, '_'),
        themeLabel: themeLabel || themeKey,
        evidence: { ...(evidence || {}), user_id: userId || null },
        weight,
    });
}

// ── B. Hourly sweep ──────────────────────────────────────────────────────

function clusterSignals(signals) {
    const byTheme = new Map();
    for (const s of signals) {
        const key = s.theme_key;
        if (!byTheme.has(key)) {
            byTheme.set(key, {
                theme_key:   key,
                theme_label: s.theme_label || key,
                users:       new Set(),
                weight_sum:  0,
                evidence_examples: [],
                first_seen:  s.observed_at,
                last_seen:   s.observed_at,
            });
        }
        const c = byTheme.get(key);
        const u = s.evidence?.user_id;
        if (u) c.users.add(u);
        c.weight_sum += Number(s.weight) || 0;
        if (c.evidence_examples.length < 5) c.evidence_examples.push(s.evidence || {});
        if (s.observed_at < c.first_seen) c.first_seen = s.observed_at;
        if (s.observed_at > c.last_seen)  c.last_seen  = s.observed_at;
    }
    return Array.from(byTheme.values());
}

/**
 * Hourly entry point — analyse the last 24h, decide which (if any) themes
 * cross the spawn threshold, and create communities for them.
 */
export async function runTrendSweep({ windowHours = 24 } = {}) {
    const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const signals  = await listRecentTrendSignals({ sinceIso, limit: 5000 });
    const clusters = clusterSignals(signals);

    // Don't re-spawn a theme that already has a live community (matched by
    // slug). Keep one community per theme at a time.
    const existing = await listNexusCommunities({ limit: 200, includeArchived: false });
    const liveSlugs = new Set(existing.map(c => c.slug));

    const spawned = [];
    for (const c of clusters) {
        if (c.users.size < SPIKE_USER_THRESHOLD)         continue;
        if (c.weight_sum < SPIKE_WEIGHT_THRESHOLD)       continue;

        const slug = `${slugify(c.theme_label)}-${new Date().toISOString().slice(0, 7)}`;
        if (liveSlugs.has(slug)) continue;
        const dup = await fetchNexusCommunityBySlug(slug);
        if (dup) continue;

        const expiresAt = new Date(Date.now() + COMMUNITY_TTL_DAYS * 86400_000).toISOString();
        const community = await insertNexusCommunity({
            slug,
            name:         c.theme_label,
            description:  `A short-lived space for people moving through ${c.theme_label.toLowerCase()} right now. Open for ${COMMUNITY_TTL_DAYS} days.`,
            is_ephemeral: true,
            expires_at:   expiresAt,
            visibility:   'public',
            trend_signal: {
                theme_key:        c.theme_key,
                theme_label:      c.theme_label,
                user_count_24h:   c.users.size,
                weight_sum_24h:   c.weight_sum,
                evidence_samples: c.evidence_examples,
                first_seen:       c.first_seen,
                last_seen:        c.last_seen,
            },
        });
        if (!community) continue;

        await suggestCommunityToResonantUsers({
            community,
            seedUserIds: Array.from(c.users),
        }).catch(() => { /* best effort */ });

        spawned.push({ community_id: community.id, slug, ...c, users: c.users.size });
    }
    return { scanned: signals.length, themes: clusters.length, spawned };
}

/**
 * For a freshly-spawned community, find users whose vault embedding is
 * close to the *seed users'* average embedding (a rough proxy for "people
 * going through similar things") and queue a friendly notification asking
 * if they want to join.
 *
 * Notifications go through the existing action_loop pipeline so they
 * inherit our quiet-hours and frequency-cap rules.
 */
export async function suggestCommunityToResonantUsers({ community, seedUserIds }) {
    if (!community?.id) return { notified: 0 };

    // Compute an average embedding from up to 20 seed users.
    const seeds = [];
    for (const u of seedUserIds.slice(0, 20)) {
        const e = await ensureUserEmbedding(u).catch(() => null);
        if (e?.embedding) seeds.push(e.embedding);
    }
    if (!seeds.length) return { notified: 0 };

    const dim = seeds[0].length;
    const avg = new Array(dim).fill(0);
    for (const v of seeds) for (let i = 0; i < dim; i++) avg[i] += v[i];
    for (let i = 0; i < dim; i++) avg[i] /= seeds.length;

    // Candidate pool — recently active users.
    const active = await listActiveUsersForActionLoop({ limit: 1000 });
    const seedSet = new Set(seedUserIds);
    const candidates = [];
    for (const row of active) {
        if (seedSet.has(row.user_id)) continue;
        const e = await ensureUserEmbedding(row.user_id).catch(() => null);
        if (!e?.embedding) continue;
        const cos = cosine(avg, e.embedding);
        if (cos >= SUGGEST_RESONANCE_FLOOR) {
            candidates.push({ user_id: row.user_id, cos });
        }
    }
    candidates.sort((a, b) => b.cos - a.cos);

    let notified = 0;
    for (const cand of candidates.slice(0, SUGGEST_NOTIFY_LIMIT)) {
        const ok = await insertActionRow({
            userId: cand.user_id,
            trigger_type:  'custom',
            scheduled_for: new Date().toISOString(),
            payload: {
                source: 'nexus_popup_suggestion',
                community_id: community.id,
                community_name: community.name,
                resonance_percent: scoreToPercent(cand.cos),
                message_hint: 'invite_popup_community',
            },
        }).catch(() => ({ ok: false }));
        if (ok) notified++;
    }
    return { notified };
}
