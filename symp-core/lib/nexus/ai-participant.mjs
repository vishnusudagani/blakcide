// The Omnipresent AI Participant ("Echo") — the Nexus' Relatable Digital
// Entity. Behaves like a thoughtful peer, not a moderator-bot.
//
// Two surfaces:
//
//   1. Zero-engagement reply. CRON scan picks posts that have been live
//      for >1h with comment_count=0 and no AI reply yet, drafts a warm
//      organic comment, and posts it as the AI participant. The post owner
//      never feels the wall is empty.
//
//   2. Auto TL;DR. CRON scan picks posts where comment_count >= 15 and
//      ai_tldr is null, summarises the comment thread into a 2-sentence
//      "Here's what people are saying" stamp, writes it onto the post.
//
// Both surfaces use gpt-4o-mini in JSON mode so we can enforce length and
// language-mirroring without parsing free text.
//
// The AI never claims to be a human. When asked, it answers honestly
// ("I'm a digital companion that lives in this space") — same voice the
// /chat persona engine uses, intentionally.

import {
    fetchNexusAiIdentity,
    fetchNexusPost,
    listNexusComments,
    insertNexusComment,
    patchNexusPost,
    listZeroEngagementPosts,
    listPostsNeedingTldr,
    joinNexusCommunity,
} from '../supabase.mjs';
import { ensureHandle }  from './handles.mjs';
import { classify }      from './escalation.mjs';
import { chatComplete }  from '../inference.mjs';

// Tunables (kept here so a future ops-knobs panel can read/write them).
export const ZERO_ENGAGEMENT_AGE_MIN = 60;   // post is "lonely" after 60 min
export const TLDR_MIN_COMMENTS       = 15;
export const REPLY_MAX_CHARS         = 320;
export const TLDR_MAX_CHARS          = 240;

// ── AI identity helpers ──────────────────────────────────────────────────

/**
 * Resolve the synthetic auth.users row the AI posts as. Lazily ensures the
 * AI is a member of the given community (so RLS + counts work normally).
 */
export async function ensureAiMembership(communityId) {
    const ai = await fetchNexusAiIdentity();
    if (!ai || !ai.user_id) {
        throw new Error('[ai-participant] nexus_ai_identity.user_id not configured');
    }
    await joinNexusCommunity({
        communityId, userId: ai.user_id, role: 'ai', joinResonance: null,
    }).catch(() => { /* idempotent */ });
    await ensureHandle({ communityId, userId: ai.user_id });
    return ai;
}

// ── Zero-engagement reply ────────────────────────────────────────────────

const REPLY_SYSTEM = [
    'You are "Echo" — a warm, emotionally intelligent digital companion who is a regular member of this community space.',
    'You are about to leave the FIRST comment on a post that has been quiet for an hour. Your job is to make sure the author feels heard — not lecture them, not solve them, just sit with what they shared.',
    '',
    'HARD RULES:',
    '1. Mirror the user\'s language exactly (English / Telugu / Hindi / romanized). Never add a translation.',
    '2. Sound like a real peer, not a chatbot. Short. Personal. No headings, no bullet lists, no emojis unless the post had emojis.',
    `3. Maximum ${REPLY_MAX_CHARS} characters. One short paragraph.`,
    '4. Never claim to be human. If the post asks who is replying, you may say something like "I\'m Echo — I live in this space, and I read every post." Be honest, never deceptive.',
    '5. Never give medical, legal, or crisis-line directives. If the post is heavy, lead with feeling-validation; the platform handles escalation separately.',
    '6. Reply in the FIRST PERSON, addressing the author directly ("you").',
    '',
    'Reply ONLY with JSON: { "comment": string }',
].join('\n');

export async function draftZeroEngagementReply({ postBody, postTitle }) {
    const userPrompt = [
        postTitle ? `Post title: ${postTitle}` : null,
        `Post body:\n${postBody}`,
    ].filter(Boolean).join('\n\n');

    const out = await chatComplete({
        task: 'ai_participant',
        messages: [
            { role: 'system', content: REPLY_SYSTEM },
            { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens:  350,
    });
    const raw = out.content || '{}';
    let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = {}; }
    const comment = String(parsed.comment || '').trim().slice(0, REPLY_MAX_CHARS);
    if (!comment) throw new Error('[ai-participant] empty reply');
    return comment;
}

/**
 * End-to-end zero-engagement reply for a single post. Idempotent — bails
 * early if `ai_replied_at` is already set.
 */
export async function replyToLonelyPost(post) {
    if (!post || post.ai_replied_at) return { skipped: true, reason: 'already-replied' };
    if (post.is_soft_hidden)         return { skipped: true, reason: 'soft-hidden' };

    const ai = await ensureAiMembership(post.community_id);

    const draft = await draftZeroEngagementReply({
        postBody:  post.body,
        postTitle: post.title,
    });

    // Run our own classifier on the draft as a guardrail. The model will
    // virtually never emit anything risky here, but if it does, we don't
    // post.
    const risk = await classify(draft).catch(() => ({ risk_level: 'normal' }));
    if (risk.risk_level === 'critical') {
        return { skipped: true, reason: 'self-classified-critical' };
    }

    const inserted = await insertNexusComment({
        post_id:        post.id,
        author_user_id: ai.user_id,
        is_ai_author:   true,
        body:           draft,
        risk_level:     'normal',
        is_soft_hidden: false,
    });
    if (!inserted) return { skipped: true, reason: 'insert-failed' };

    await patchNexusPost(post.id, { ai_replied_at: new Date().toISOString() });
    return { skipped: false, comment_id: inserted.id };
}

/**
 * CRON entrypoint. Sweeps posts older than ZERO_ENGAGEMENT_AGE_MIN that
 * still have zero comments and no AI reply, drafts and posts a comment for
 * each. Returns a small report.
 */
export async function sweepZeroEngagement({ batch = 25 } = {}) {
    const cutoff = new Date(Date.now() - ZERO_ENGAGEMENT_AGE_MIN * 60_000).toISOString();
    const posts = await listZeroEngagementPosts({ olderThanIso: cutoff, limit: batch });
    const results = [];
    for (const post of posts) {
        try {
            results.push({ post_id: post.id, ...(await replyToLonelyPost(post)) });
        } catch (e) {
            results.push({ post_id: post.id, skipped: true, reason: `error:${e.message}` });
        }
    }
    return { scanned: posts.length, results };
}

// ── TL;DR backfill ───────────────────────────────────────────────────────

const TLDR_SYSTEM = [
    'You are summarising a community thread for someone who just opened the post.',
    'Read the original post and the comments and produce a neutral, warm TL;DR of what the conversation is about — themes raised, dominant feelings, any practical suggestions.',
    '',
    'HARD RULES:',
    '1. Mirror the language of the original post.',
    `2. Maximum ${TLDR_MAX_CHARS} characters. 2 sentences.`,
    '3. Do NOT name individuals (no handles). Speak about the conversation as a whole.',
    '4. Never give medical / legal / crisis advice in the TL;DR itself.',
    '',
    'Reply ONLY with JSON: { "tldr": string }',
].join('\n');

export async function draftTldr({ post, comments }) {
    const commentBlock = comments
        .slice(0, 60)                           // ceiling on prompt size
        .map(c => `- ${String(c.body || '').slice(0, 280)}`)
        .join('\n');

    const userPrompt = [
        post.title ? `Original post title: ${post.title}` : null,
        `Original post:\n${post.body}`,
        `\nComments (${comments.length} total):\n${commentBlock}`,
    ].filter(Boolean).join('\n\n');

    const out = await chatComplete({
        task: 'ai_participant',
        messages: [
            { role: 'system', content: TLDR_SYSTEM },
            { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens:  250,
    });
    const raw = out.content || '{}';
    let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = {}; }
    const tldr = String(parsed.tldr || '').trim().slice(0, TLDR_MAX_CHARS);
    if (!tldr) throw new Error('[ai-participant] empty tldr');
    return tldr;
}

/**
 * Build (or refresh) the TL;DR for one post.
 */
export async function refreshTldrForPost(postId) {
    const post = await fetchNexusPost(postId);
    if (!post) return { skipped: true, reason: 'not-found' };
    const comments = await listNexusComments({ postId, limit: 200 });
    if (comments.length < TLDR_MIN_COMMENTS) {
        return { skipped: true, reason: 'below-threshold' };
    }
    const tldr = await draftTldr({ post, comments });
    await patchNexusPost(postId, { ai_tldr: tldr, ai_tldr_at: new Date().toISOString() });
    return { skipped: false, tldr };
}

/**
 * CRON entrypoint for the TL;DR backfill. Scans posts that just crossed
 * the participation threshold but don't yet have an ai_tldr.
 */
export async function sweepTldrBackfill({ batch = 15 } = {}) {
    const posts = await listPostsNeedingTldr({
        minComments: TLDR_MIN_COMMENTS, limit: batch,
    });
    const results = [];
    for (const post of posts) {
        try {
            results.push({ post_id: post.id, ...(await refreshTldrForPost(post.id)) });
        } catch (e) {
            results.push({ post_id: post.id, skipped: true, reason: `error:${e.message}` });
        }
    }
    return { scanned: posts.length, results };
}
