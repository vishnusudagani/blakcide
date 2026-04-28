// Resonance Matching — vault-embedding similarity between any two users.
//
// The user-visible promise (e.g., "85% Match" next to a post) maps to
// cosine similarity between the viewer's vault embedding and the target's,
// rescaled from [-1, 1] to a 0–100 percentage. Scores are cached in
// nexus_resonance_scores per (viewer, target) and invalidated whenever
// either side's vault source_version moves on.
//
// We never call the OpenAI Embeddings API on the read path. Embeddings are
// recomputed only when the user's vault analysis is refreshed (via
// `ensureUserEmbedding`) — usually nightly via the action loop.

import {
    fetchVaultProfile,
    fetchNexusVaultEmbedding,
    upsertNexusVaultEmbedding,
    fetchResonanceScore,
    upsertResonanceScore,
} from '../supabase.mjs';
import { embed } from '../inference.mjs';

// Schema is locked to vector(1536). The router default (OpenAI
// text-embedding-3-small) is 1536 native; Voyage voyage-large-2 is also 1536
// and a drop-in via SYMP_EMBED_PROVIDER=voyage. Other models (BGE-M3 @ 1024,
// etc.) require a schema migration first — see /supabase/migrations.
const REQUIRED_DIM = 1536;

// ── Embedding helpers ────────────────────────────────────────────────────

/**
 * Build a compact text representation of a user's vault that captures the
 * texture we want resonance to match on. We deliberately skip raw journal
 * content (PII / surface noise) and key off the analyser's structured
 * output: psychology, themes, recent emotional metrics.
 */
function vaultToEmbeddingText(vaultProfile) {
    if (!vaultProfile) return '';
    const a = vaultProfile.symp_analysis || {};
    const psych = a.psychology  ? `Psychology: ${JSON.stringify(a.psychology)}` : '';
    const themes = Array.isArray(a.key_themes) && a.key_themes.length
        ? `Themes: ${a.key_themes.join(', ')}` : '';
    const metrics = a.metrics ? `Metrics: ${JSON.stringify(a.metrics)}` : '';
    return [psych, themes, metrics].filter(Boolean).join('\n').slice(0, 4000);
}

/**
 * Source-version key derived from the vault row. When the analyser writes
 * a new analysis, last_analyzed_at moves — so does this version string,
 * which invalidates any cached resonance scores keyed against it.
 */
function vaultVersion(vaultProfile) {
    if (!vaultProfile) return 'v0';
    return String(vaultProfile.last_analyzed_at || vaultProfile.updated_at || 'v0');
}

async function callEmbed(text) {
    // Truncate at 1536 dims (OpenAI text-embedding-3-* supports the
    // `dimensions` param; other providers ignore unknown fields).
    const out = await embed({ input: text, dimensions: REQUIRED_DIM });
    if (!Array.isArray(out.embedding) || out.embedding.length !== REQUIRED_DIM) {
        throw new Error(
            `[resonance] embed returned dim=${out.embedding?.length}; ` +
            `expected ${REQUIRED_DIM}. Provider=${out.provider} model=${out.model_used}. ` +
            `Either pick a 1536-dim model or run a schema migration first.`,
        );
    }
    return out.embedding;
}

/**
 * Ensure the user has a current vault embedding row. Returns
 * { embedding, source_version } or null if the user has no vault analysis
 * yet (resonance is undefined for cold users — caller should fall back to
 * a neutral score of 0.5).
 */
export async function ensureUserEmbedding(userId) {
    if (!userId) return null;
    const vault = await fetchVaultProfile(userId);
    if (!vault) return null;
    const wantedVersion = vaultVersion(vault);
    const cached = await fetchNexusVaultEmbedding(userId);
    if (cached && cached.source_version === wantedVersion) {
        return { embedding: cached.embedding, source_version: cached.source_version };
    }
    const text = vaultToEmbeddingText(vault);
    if (!text) return null;
    const vec = await callEmbed(text);
    await upsertNexusVaultEmbedding({
        userId, embedding: vec, sourceVersion: wantedVersion,
    });
    return { embedding: vec, source_version: wantedVersion };
}

// ── Cosine + score conversion ────────────────────────────────────────────

/**
 * Cosine similarity in [-1, 1]. Inputs may arrive as JS arrays (when we
 * just computed them) or as the PostgREST string form '[0.1,0.2,...]'.
 */
export function cosine(a, b) {
    const va = toArray(a);
    const vb = toArray(b);
    if (!va.length || va.length !== vb.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.length; i++) {
        dot += va[i] * vb[i];
        na  += va[i] * va[i];
        nb  += vb[i] * vb[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (_) { return []; }
    }
    return [];
}

/**
 * Rescale cosine similarity to a 0–100 user-facing percentage. We squash
 * with (cos + 1) / 2 so anti-resonance (cos < 0) doesn't get a negative
 * label — it just becomes a low score.
 */
export function scoreToPercent(cosScore) {
    const clamped = Math.max(-1, Math.min(1, cosScore));
    return Math.round(((clamped + 1) / 2) * 100);
}

// ── Pairwise scoring (cached) ────────────────────────────────────────────

/**
 * Resonance between viewer and target. Returns { percent, raw } where raw
 * is the cosine similarity. Caches the row so repeated feed renders don't
 * recompute. If either user has no vault embedding yet, returns a neutral
 * { percent: 50, raw: 0, neutral: true }.
 */
export async function resonanceBetween(viewerUserId, targetUserId) {
    if (!viewerUserId || !targetUserId) return { percent: 50, raw: 0, neutral: true };
    if (viewerUserId === targetUserId)   return { percent: 100, raw: 1 };

    const [viewerEmb, targetEmb] = await Promise.all([
        ensureUserEmbedding(viewerUserId).catch(() => null),
        ensureUserEmbedding(targetUserId).catch(() => null),
    ]);
    if (!viewerEmb || !targetEmb) return { percent: 50, raw: 0, neutral: true };

    // Cache hit?
    const cached = await fetchResonanceScore({ viewerUserId, targetUserId });
    if (cached
        && cached.viewer_version === viewerEmb.source_version
        && cached.target_version === targetEmb.source_version) {
        const raw = Number(cached.score);
        return { percent: scoreToPercent(raw), raw };
    }

    const raw = cosine(viewerEmb.embedding, targetEmb.embedding);
    await upsertResonanceScore({
        viewerUserId, targetUserId,
        score: raw,
        viewerVersion: viewerEmb.source_version,
        targetVersion: targetEmb.source_version,
    }).catch(() => { /* best effort */ });

    return { percent: scoreToPercent(raw), raw };
}

/**
 * Bulk variant — score `viewer` against every user in `targets[]`. Returns
 * a map { [target_user_id]: { percent, raw, neutral? } }. Used by the feed
 * decorator.
 */
export async function resonanceBulk(viewerUserId, targetUserIds) {
    const out = {};
    if (!viewerUserId || !targetUserIds?.length) return out;
    // Sequential to be gentle on the cache table; the embedding fetch is
    // the expensive bit and we already memoise per-process via short-lived
    // promise caching at the SDK level if needed.
    for (const target of targetUserIds) {
        out[target] = await resonanceBetween(viewerUserId, target);
    }
    return out;
}
