// Nexus (Community Module) — public API surface.
//
// One handler, multiple paths. Each path is allowlisted in the proxy at
// netlify/functions/blaksyd-symp-proxy.mjs and prefixed `nexus/`.
//
// Endpoints:
//   GET  /nexus/communities                     → list communities
//   POST /nexus/communities                     → create (admin/devx — gated by SYMP_ALLOW_USER_COMMUNITY_CREATE)
//   GET  /nexus/communities/by-slug?slug=…      → fetch one
//   POST /nexus/communities/join                → { community_id }
//   POST /nexus/communities/leave               → { community_id }
//
//   GET  /nexus/feed?community_id=…&before=…    → resonance-decorated post feed
//   POST /nexus/posts                           → { community_id, title?, body }
//   GET  /nexus/posts?id=…                      → single post + decorated comments
//   POST /nexus/comments                        → { post_id, parent_id?, body }
//
//   POST /nexus/impacts                         → { post_id?|comment_id?, impact_type }
//   DELETE /nexus/impacts                       → same shape (PostgREST-style)
//
//   GET  /nexus/me/impact-stats                 → { given, received } (positive metric)
//
// All writes are run through:
//   1. Anonymous-handle resolution (so the response carries a handle, not a user_id).
//   2. Distress classification (escalation pipeline runs async, never blocks).

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, jsonSuccess, readJson, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

import {
    listNexusCommunities, fetchNexusCommunity, fetchNexusCommunityBySlug,
    insertNexusCommunity, joinNexusCommunity, leaveNexusCommunity,
    listNexusPosts, fetchNexusPost, insertNexusPost, patchNexusPost,
    listNexusComments, insertNexusComment,
    insertNexusImpact, deleteNexusImpact,
    countImpactsGivenByUser, countImpactsReceivedByUser,
} from '../../symp-core/lib/supabase.mjs';
import { ensureHandle, resolveHandles } from '../../symp-core/lib/nexus/handles.mjs';
import { resonanceBulk } from '../../symp-core/lib/nexus/resonance.mjs';
import { classify, escalateToHumanConnect } from '../../symp-core/lib/nexus/escalation.mjs';
import { recordSignal } from '../../symp-core/lib/nexus/trend-analyzer.mjs';

const { ERROR_CODES } = SympContract;

// User-created communities default to ON. Set SYMP_ALLOW_USER_COMMUNITY_CREATE=false
// to disable (e.g. during incident response).
const ALLOW_USER_COMMUNITY_CREATE =
    String(process.env.SYMP_ALLOW_USER_COMMUNITY_CREATE || 'true').toLowerCase() !== 'false';

// ── Slug helpers ──────────────────────────────────────────────────────────
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

const IMPACT_TYPES = new Set(['felt_seen','resonated','helpful','sending_strength']);

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Project a post row into the API response shape: replaces author_user_id
 * with the anonymous handle, attaches resonance score (vs the viewer), and
 * strips the raw embedding.
 */
function projectPost(post, handle, resonance) {
    return {
        id:             post.id,
        community_id:   post.community_id,
        is_ai_author:   post.is_ai_author,
        author:         handle ? { handle: handle.handle, avatar_seed: handle.avatar_seed } : null,
        title:          post.title,
        body:           post.body,
        risk_level:     post.risk_level,
        is_soft_hidden: post.is_soft_hidden,
        impact_count:   post.impact_count,
        comment_count:  post.comment_count,
        ai_tldr:        post.ai_tldr,
        ai_tldr_at:     post.ai_tldr_at,
        ai_replied_at:  post.ai_replied_at,
        created_at:     post.created_at,
        updated_at:     post.updated_at,
        resonance:      resonance || null,
    };
}

function projectComment(comment, handle) {
    return {
        id:             comment.id,
        post_id:        comment.post_id,
        is_ai_author:   comment.is_ai_author,
        author:         handle ? { handle: handle.handle, avatar_seed: handle.avatar_seed } : null,
        parent_id:      comment.parent_id,
        body:           comment.body,
        risk_level:     comment.risk_level,
        is_soft_hidden: comment.is_soft_hidden,
        impact_count:   comment.impact_count,
        created_at:     comment.created_at,
        updated_at:     comment.updated_at,
    };
}

// ── Handler ──────────────────────────────────────────────────────────────

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    const t0        = Date.now();
    const requestId = getRequestId(req);
    const url       = new URL(req.url);
    const path      = url.pathname.replace(/\/+$/,'');
    const auth      = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: path, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    try {
        // ── Communities ────────────────────────────────────────────────
        if (path.endsWith('/nexus/communities') && req.method === 'GET') {
            const list = await listNexusCommunities({ limit: 50 });
            return jsonSuccess({ communities: list }, requestId);
        }

        if (path.endsWith('/nexus/communities/by-slug') && req.method === 'GET') {
            const slug = url.searchParams.get('slug');
            if (!slug) return jsonError(ERROR_CODES.BAD_REQUEST, 'slug required', 400, requestId);
            const row = await fetchNexusCommunityBySlug(slug);
            if (!row) return jsonError(ERROR_CODES.BAD_REQUEST, 'not found', 404, requestId);
            return jsonSuccess(row, requestId);
        }

        if (path.endsWith('/nexus/communities') && req.method === 'POST') {
            if (!ALLOW_USER_COMMUNITY_CREATE) {
                return jsonError(ERROR_CODES.BAD_REQUEST, 'User-created communities are disabled in this environment', 403, requestId);
            }
            const parsed = await readJson(req);
            if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
            const { user_id, name, description } = parsed.data || {};
            let { slug } = parsed.data || {};
            if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            if (!name || !String(name).trim()) {
                return jsonError(ERROR_CODES.BAD_REQUEST, 'name required', 400, requestId);
            }
            const cleanName = String(name).trim().slice(0, 120);
            // Auto-derive slug from name if not provided.
            slug = slugify(slug || cleanName);
            if (!slug) slug = 'c-' + Math.random().toString(36).slice(2, 8);

            // Soft collision handling — if slug is already taken, append a
            // short random suffix and try once more.
            let row = null;
            try {
                row = await insertNexusCommunity({
                    slug,
                    name:         cleanName,
                    description:  description ? String(description).trim().slice(0, 500) : null,
                    is_ephemeral: false,
                    visibility:   'public',
                });
            } catch (_) { row = null; }

            if (!row) {
                // Likely slug collision. Retry with a suffix.
                const slug2 = `${slug.slice(0, 52)}-${Math.random().toString(36).slice(2, 6)}`;
                try {
                    row = await insertNexusCommunity({
                        slug: slug2,
                        name: cleanName,
                        description: description ? String(description).trim().slice(0, 500) : null,
                        is_ephemeral: false,
                        visibility:   'public',
                    });
                } catch (_) { row = null; }
            }
            if (!row) return jsonError(ERROR_CODES.INTERNAL_ERROR, 'Could not create community (try a different name)', 500, requestId);

            // Auto-join the creator + mint their handle so they can post immediately.
            try {
                await joinNexusCommunity({ communityId: row.id, userId: user_id, role: 'moderator' });
                await ensureHandle({ communityId: row.id, userId: user_id });
            } catch (_) { /* best-effort */ }

            logAccess({ requestId, endpoint: path, userId: user_id, statusCode: 201, latencyMs: Date.now() - t0 });
            return jsonSuccess({ community: row }, requestId, 201);
        }

        if (path.endsWith('/nexus/communities/join') && req.method === 'POST') {
            const parsed = await readJson(req);
            if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
            const { user_id, community_id } = parsed.data || {};
            if (!user_id)      return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            if (!community_id) return jsonError(ERROR_CODES.BAD_REQUEST, 'community_id required', 400, requestId);
            await joinNexusCommunity({ communityId: community_id, userId: user_id });
            await ensureHandle({ communityId: community_id, userId: user_id });
            return jsonSuccess({ joined: true }, requestId);
        }

        if (path.endsWith('/nexus/communities/leave') && req.method === 'POST') {
            const parsed = await readJson(req);
            if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
            const { user_id, community_id } = parsed.data || {};
            if (!user_id)      return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            if (!community_id) return jsonError(ERROR_CODES.BAD_REQUEST, 'community_id required', 400, requestId);
            await leaveNexusCommunity({ communityId: community_id, userId: user_id });
            return jsonSuccess({ left: true }, requestId);
        }

        // ── Feed ────────────────────────────────────────────────────────
        if (path.endsWith('/nexus/feed') && req.method === 'GET') {
            const userId      = url.searchParams.get('user_id');
            const communityId = url.searchParams.get('community_id');
            const before      = url.searchParams.get('before') || undefined;
            const limit       = Math.min(50, Number(url.searchParams.get('limit') || 30));
            if (!communityId) return jsonError(ERROR_CODES.BAD_REQUEST, 'community_id required', 400, requestId);

            const posts = await listNexusPosts({ communityId, limit, before });
            const authorIds = posts.map(p => p.author_user_id);
            const handles   = await resolveHandles({ communityId, userIds: authorIds });
            // Resonance: compute viewer→author for each post (skip self).
            const targets = Array.from(new Set(authorIds.filter(id => id && id !== userId)));
            const reso    = userId ? await resonanceBulk(userId, targets) : {};

            const projected = posts.map(p => projectPost(
                p,
                handles[p.author_user_id],
                p.author_user_id === userId ? { percent: 100, raw: 1, self: true } : reso[p.author_user_id],
            ));
            return jsonSuccess({ posts: projected }, requestId);
        }

        // ── Single post (with comments) ────────────────────────────────
        if (path.endsWith('/nexus/posts') && req.method === 'GET') {
            const userId = url.searchParams.get('user_id');
            const postId = url.searchParams.get('id');
            if (!postId) return jsonError(ERROR_CODES.BAD_REQUEST, 'id required', 400, requestId);
            const post = await fetchNexusPost(postId);
            if (!post) return jsonError(ERROR_CODES.BAD_REQUEST, 'not found', 404, requestId);

            const comments = await listNexusComments({ postId, limit: 200 });
            const allUserIds = Array.from(new Set([post.author_user_id, ...comments.map(c => c.author_user_id)]));
            const handles    = await resolveHandles({ communityId: post.community_id, userIds: allUserIds });

            const targets = allUserIds.filter(id => id && id !== userId);
            const reso    = userId ? await resonanceBulk(userId, targets) : {};

            return jsonSuccess({
                post:     projectPost(post, handles[post.author_user_id],
                                post.author_user_id === userId
                                    ? { percent: 100, raw: 1, self: true }
                                    : reso[post.author_user_id]),
                comments: comments.map(c => projectComment(c, handles[c.author_user_id])),
            }, requestId);
        }

        // ── Create post ────────────────────────────────────────────────
        if (path.endsWith('/nexus/posts') && req.method === 'POST') {
            const parsed = await readJson(req);
            if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
            const { user_id, community_id, title, body } = parsed.data || {};
            if (!user_id)      return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            if (!community_id) return jsonError(ERROR_CODES.BAD_REQUEST, 'community_id required', 400, requestId);
            if (!body || !String(body).trim()) {
                return jsonError(ERROR_CODES.BAD_REQUEST, 'body required', 400, requestId);
            }
            const community = await fetchNexusCommunity(community_id);
            if (!community) return jsonError(ERROR_CODES.BAD_REQUEST, 'community not found', 404, requestId);

            // Synchronous distress classification — we want to know BEFORE
            // we publish whether to soft-hide. The classifier is fast
            // (<300ms median for the lexical+LLM path).
            const risk = await classify(body).catch(() => ({ risk_level: 'normal', reasons: ['classify-error'] }));
            const isCritical = risk.risk_level === 'critical';

            const inserted = await insertNexusPost({
                community_id,
                author_user_id: user_id,
                is_ai_author:   false,
                title:          title ? String(title).slice(0, 200) : null,
                body:           String(body).slice(0, 8000),
                risk_level:     risk.risk_level,
                is_soft_hidden: isCritical,
            });
            if (!inserted) return jsonError(ERROR_CODES.INTERNAL_ERROR, 'insert failed', 500, requestId);

            // Anonymous handle (mints if missing).
            const handle = await ensureHandle({ communityId: community_id, userId: user_id });

            // Side effects fire-and-forget.
            if (isCritical) {
                escalateToHumanConnect({
                    userId: user_id, postId: inserted.id, reasons: risk.reasons,
                }).catch(() => {});
            }
            // Trend signal — coarse-grained classification of what the post
            // is about (using the first key word of the title or body).
            const signalLabel = (title || body).slice(0, 40);
            recordSignal({
                userId:     user_id,
                themeKey:   signalLabel.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,40),
                themeLabel: signalLabel,
                weight:     isCritical ? 3 : 1,
                evidence:   { post_id: inserted.id },
            }).catch(() => {});

            logAccess({ requestId, endpoint: path, userId: user_id, statusCode: 201, latencyMs: Date.now() - t0 });
            return jsonSuccess({
                post: projectPost(inserted, handle, { percent: 100, raw: 1, self: true }),
            }, requestId, 201);
        }

        // ── Create comment ─────────────────────────────────────────────
        if (path.endsWith('/nexus/comments') && req.method === 'POST') {
            const parsed = await readJson(req);
            if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
            const { user_id, post_id, parent_id, body } = parsed.data || {};
            if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            if (!post_id) return jsonError(ERROR_CODES.BAD_REQUEST, 'post_id required', 400, requestId);
            if (!body || !String(body).trim()) {
                return jsonError(ERROR_CODES.BAD_REQUEST, 'body required', 400, requestId);
            }
            const post = await fetchNexusPost(post_id);
            if (!post) return jsonError(ERROR_CODES.BAD_REQUEST, 'post not found', 404, requestId);

            const risk = await classify(body).catch(() => ({ risk_level: 'normal', reasons: ['classify-error'] }));
            const isCritical = risk.risk_level === 'critical';

            const inserted = await insertNexusComment({
                post_id,
                author_user_id: user_id,
                is_ai_author:   false,
                parent_id:      parent_id || null,
                body:           String(body).slice(0, 4000),
                risk_level:     risk.risk_level,
                is_soft_hidden: isCritical,
            });
            if (!inserted) return jsonError(ERROR_CODES.INTERNAL_ERROR, 'insert failed', 500, requestId);

            const handle = await ensureHandle({ communityId: post.community_id, userId: user_id });

            if (isCritical) {
                escalateToHumanConnect({
                    userId: user_id, commentId: inserted.id, reasons: risk.reasons,
                }).catch(() => {});
            }

            logAccess({ requestId, endpoint: path, userId: user_id, statusCode: 201, latencyMs: Date.now() - t0 });
            return jsonSuccess({ comment: projectComment(inserted, handle) }, requestId, 201);
        }

        // ── Impacts ────────────────────────────────────────────────────
        if (path.endsWith('/nexus/impacts') && (req.method === 'POST' || req.method === 'DELETE')) {
            const parsed = await readJson(req);
            if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON', 400, requestId);
            const { user_id, post_id, comment_id, impact_type } = parsed.data || {};
            if (!user_id) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            if (!IMPACT_TYPES.has(impact_type)) {
                return jsonError(ERROR_CODES.BAD_REQUEST, 'invalid impact_type', 400, requestId);
            }
            if (Boolean(post_id) === Boolean(comment_id)) {
                return jsonError(ERROR_CODES.BAD_REQUEST, 'exactly one of post_id|comment_id required', 400, requestId);
            }
            if (req.method === 'POST') {
                await insertNexusImpact({
                    user_id, post_id: post_id || null, comment_id: comment_id || null, impact_type,
                });
                return jsonSuccess({ given: true }, requestId);
            } else {
                await deleteNexusImpact({ userId: user_id, postId: post_id, commentId: comment_id, impactType: impact_type });
                return jsonSuccess({ withdrawn: true }, requestId);
            }
        }

        // ── Impact stats (positive metric powering "Your story helped N people today") ──
        if (path.endsWith('/nexus/me/impact-stats') && req.method === 'GET') {
            const userId = url.searchParams.get('user_id');
            const days   = Math.min(30, Number(url.searchParams.get('days') || 1));
            if (!userId) return jsonError(ERROR_CODES.MISSING_USER_ID, 'user_id required', 400, requestId);
            const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
            const [given, received] = await Promise.all([
                countImpactsGivenByUser({ userId, sinceIso }),
                countImpactsReceivedByUser({ userId, sinceIso }),
            ]);
            return jsonSuccess({ window_days: days, given, received }, requestId);
        }

        return new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
        logAccess({ requestId, endpoint: path, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, e.message || 'unexpected error', 500, requestId);
    }
};

export const config = {
    path: [
        '/api/symp/v1/nexus/communities',
        '/api/symp/v1/nexus/communities/by-slug',
        '/api/symp/v1/nexus/communities/join',
        '/api/symp/v1/nexus/communities/leave',
        '/api/symp/v1/nexus/feed',
        '/api/symp/v1/nexus/posts',
        '/api/symp/v1/nexus/comments',
        '/api/symp/v1/nexus/impacts',
        '/api/symp/v1/nexus/me/impact-stats',
    ],
};
