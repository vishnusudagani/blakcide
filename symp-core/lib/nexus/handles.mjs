// Anonymous per-community handles.
//
// Inside the Nexus, a user's real auth.users.id is NEVER projected to other
// members. Each (user, community) pair gets a stable pseudonymous handle
// like "WildOcean42" so the same user can be recognised across a single
// community's threads — but no two communities share the same handle for
// the same user. That makes cross-community fingerprinting infeasible.
//
// The handle is generated lazily on first post/comment and persisted in
// nexus_anonymous_handles. Subsequent calls return the cached row.

import {
    fetchNexusHandle,
    insertNexusHandle,
    fetchNexusHandlesBulk,
} from '../supabase.mjs';

// Curated wordlists. Kept short on purpose — tens-of-thousands of unique
// pairs are enough for a single community before we'd start colliding,
// and the random-suffix integer keeps blowing the collision space wide.
const ADJECTIVES = [
    'Wild','Quiet','Gentle','Bright','Brave','Kind','Curious','Mellow','Warm','Soft',
    'Calm','Bold','Steady','Clear','Glad','Honest','Open','Patient','Quick','Still',
    'Sunny','True','Wise','Eager','Free','Glow','Hopeful','Lively','Nimble','Plucky',
    'Radiant','Sincere','Tender','Vivid','Whole','Easy','Fierce','Grateful','Humble','Joyful',
];
const NOUNS = [
    'Ocean','Mountain','River','Sky','Forest','Meadow','Wave','Cloud','Stone','Flame',
    'Bird','Tide','Star','Moon','Lantern','Path','Bridge','Harbor','Garden','Compass',
    'Echo','Spark','Breeze','Petal','Lake','Trail','Peak','Shore','Vale','Brook',
    'Falcon','Heron','Sparrow','Otter','Fox','Wolf','Deer','Whale','Dove','Phoenix',
];

// Cap the random suffix so the handle stays human-pronounceable. With
// 40×40×100 = 160k unique combos per community we'll never run dry.
const SUFFIX_MAX = 100;

function randomHandle() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(Math.random() * SUFFIX_MAX);
    return `${adj}${noun}${num}`;
}

function randomAvatarSeed() {
    // Short hex string; the frontend can map this to a deterministic SVG
    // avatar (e.g., DiceBear). Stable per-row, never re-seeded.
    return Math.random().toString(16).slice(2, 10);
}

/**
 * Resolve (or mint) the handle for a given (community, user) pair.
 * Always returns { handle, avatar_seed }. If the row exists, returns it.
 * If not, mints a new one and inserts it. On the rare insertion conflict
 * (handle already taken in this community by another user), retries up to
 * MAX_RETRIES times with a fresh random handle.
 */
const MAX_RETRIES = 6;

export async function ensureHandle({ communityId, userId }) {
    if (!communityId || !userId) {
        throw new Error('ensureHandle: communityId + userId required');
    }
    const cached = await fetchNexusHandle({ communityId, userId });
    if (cached) return cached;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const handle = randomHandle();
        const avatarSeed = randomAvatarSeed();
        const inserted = await insertNexusHandle({
            communityId, userId, handle, avatarSeed,
        });
        if (inserted) return { handle: inserted.handle, avatar_seed: inserted.avatar_seed };
        // Insert failed — most likely because a parallel writer already
        // claimed the (community_id, user_id) row OR another user grabbed
        // this exact handle in this community. Re-read first.
        const refetched = await fetchNexusHandle({ communityId, userId });
        if (refetched) return refetched;
    }
    // Fallback: deterministic-but-ugly handle so we don't block writes.
    const fallback = `User${Math.random().toString(36).slice(2, 8)}`;
    const seed = randomAvatarSeed();
    const inserted = await insertNexusHandle({
        communityId, userId, handle: fallback, avatarSeed: seed,
    });
    return inserted
        ? { handle: inserted.handle, avatar_seed: inserted.avatar_seed }
        : { handle: fallback, avatar_seed: seed };
}

/**
 * Bulk-resolve handles for many (user, community) pairs. Used by the feed
 * renderer so we don't N+1 the handles table.
 *
 * Mints handles for any users that don't yet have one in this community.
 * Returns a map { [user_id]: { handle, avatar_seed } }.
 */
export async function resolveHandles({ communityId, userIds }) {
    const unique = Array.from(new Set(userIds.filter(Boolean)));
    if (!unique.length) return {};
    const existing = await fetchNexusHandlesBulk({ communityId, userIds: unique });
    const missing = unique.filter(u => !existing[u]);
    for (const userId of missing) {
        const row = await ensureHandle({ communityId, userId });
        existing[userId] = row;
    }
    return existing;
}
