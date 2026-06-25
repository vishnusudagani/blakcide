// Nexus data-access layer — the single seam between the UI and the backend.
//
// Phase 0 of NEXUS-GAPS.md introduces a server-proxy identity model: the browser
// must never receive another member's raw auth.users.id (that leak let the same
// person be linked across tribes despite per-tribe handles — #12/#13/#14).
//
// This module exposes ONE normalised shape for posts / comments / DMs and hides
// WHICH path produced it:
//   • PROXY path  (flag on)  → reads identity-safe views, writes via SECURITY
//     DEFINER RPCs. Author identity is an opaque per-tribe `token`, never a uid.
//   • LEGACY path (flag off) → today's direct-to-table reads/writes. The "token"
//     is just the raw uid (kept internal), and the handle is derived client-side.
//
// The flag is PUBLIC_NEXUS_PROXY ('1' = on). Default OFF, so production behaviour
// is byte-for-byte unchanged until we flip it and verify.

import { supabase } from '../../lib/supabaseClient';

export const NEXUS_PROXY: boolean =
  (import.meta.env.PUBLIC_NEXUS_PROXY as string | undefined) === '1';

const BLAK_UID = 'b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab';

// ── normalised shapes the UI renders ───────────────────────────────────────
export interface NxPost {
  id: string;
  community_id: string;
  is_ai_author: boolean;
  title: string | null;
  body: string | null;
  image_url: string | null;
  impact_count: number;
  comment_count: number;
  created_at: string;
  author_token: string;   // opaque identity key: colour seed + DM target
  author_handle: string;  // display handle (never a real name)
  is_mine: boolean;
  my_resonated: boolean;
}
export interface NxComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  is_ai_author: boolean;
  body: string | null;
  image_url: string | null;
  created_at: string;
  author_token: string;
  author_handle: string;
  is_mine: boolean;
}
export interface NxDM {
  id: string;
  community_id: string;
  body: string | null;
  image_url: string | null;
  created_at: string;
  is_mine: boolean;
  other_token: string;
  other_handle: string;
}
export interface NxInboxRow {
  community_id: string;
  other_token: string;
  other_handle: string;
  last_body: string;
  last_at: string;
  status: string;       // 'pending' | 'accepted'
  is_request: boolean;  // they messaged me first and I haven't accepted
}

// ── legacy client-side handle (deterministic), kept identical to the live UI ─
const ADJ = ['quiet','warm','steady','night','soft','open','kind','calm','bright','still','easy','true','gentle','lucid','amber','golden','hidden','distant','velvet','lunar','drifting','slow','mellow','wandering'];
const NOUN = ['harbor','signal','ember','meadow','tide','comet','willow','lantern','river','pine','spark','haven','cedar','orchard','thicket','current','beacon','hollow','summit','delta','cove','aurora','marsh','dune'];
const hashIdx = (s: string) => { let h = 0; s = s || ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const legacyHandle = (seed: string) => ADJ[hashIdx(seed) % ADJ.length] + '-' + NOUN[hashIdx(seed + 'n') % NOUN.length] + '-' + (hashIdx(seed + 'x') % 90 + 10);
const legacyHandleFor = (uid: string, comm: string) => legacyHandle((uid || 'x') + (comm || ''));

const sb = () => {
  if (!supabase) throw new Error('Supabase not configured');
  return supabase;
};

// ════════════════════════════ POSTS / FEED ════════════════════════════════
const POST_COLS = 'id,community_id,is_ai_author,title,body,image_url,impact_count,comment_count,created_at';

/** Discussions in a tribe, newest first, normalised. */
export async function loadDiscussions(communityId: string, myUid: string | null): Promise<NxPost[]> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb()
      .from('nexus_posts_view')
      .select('*')
      .eq('community_id', communityId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data || []) as NxPost[];
  }
  // legacy: read base table + a second query for my resonance set
  const { data: posts, error } = await sb()
    .from('nexus_posts')
    .select(POST_COLS + ',author_user_id')
    .eq('community_id', communityId)
    .eq('is_soft_hidden', false)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = posts || [];
  const mine = new Set<string>();
  if (myUid && rows.length) {
    const { data: imp } = await sb()
      .from('nexus_impacts')
      .select('post_id')
      .eq('user_id', myUid)
      .eq('impact_type', 'resonated')
      .in('post_id', rows.map((p: any) => p.id));
    (imp || []).forEach((r: any) => mine.add(r.post_id));
  }
  return rows.map((p: any) => legacyPost(p, communityId, myUid, mine.has(p.id)));
}

/** Recent posts across several tribes (home tiles), grouped client-side. */
export async function loadRecentPosts(communityIds: string[], myUid: string | null, perTribe = 3): Promise<Record<string, NxPost[]>> {
  const out: Record<string, NxPost[]> = {};
  if (!communityIds.length) return out;
  if (NEXUS_PROXY) {
    const { data } = await sb()
      .from('nexus_posts_view')
      .select('*')
      .in('community_id', communityIds)
      .order('created_at', { ascending: false })
      .limit(60);
    (data || []).forEach((p: any) => {
      (out[p.community_id] ||= []).length < perTribe && out[p.community_id].push(p as NxPost);
    });
    return out;
  }
  const { data } = await sb()
    .from('nexus_posts')
    .select(POST_COLS + ',author_user_id')
    .in('community_id', communityIds)
    .eq('is_soft_hidden', false)
    .order('created_at', { ascending: false })
    .limit(60);
  (data || []).forEach((p: any) => {
    const arr = (out[p.community_id] ||= []);
    if (arr.length < perTribe) arr.push(legacyPost(p, p.community_id, myUid, false));
  });
  return out;
}

/** Create a post. Returns the normalised created row. */
export async function createPost(
  communityId: string, title: string | null, body: string, imageUrl: string | null, myUid: string | null,
): Promise<NxPost> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_create_post', {
      p_community: communityId, p_title: title, p_body: body, p_image_url: imageUrl,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as NxPost;
  }
  const { data, error } = await sb()
    .from('nexus_posts')
    .insert({ community_id: communityId, author_user_id: myUid, title: title || null, body: body || '', image_url: imageUrl })
    .select(POST_COLS + ',author_user_id')
    .single();
  if (error) throw error;
  return legacyPost(data, communityId, myUid, false);
}

// ════════════════════════════ COMMENTS ════════════════════════════════════
export async function loadComments(postId: string, communityId: string, myUid: string | null): Promise<NxComment[]> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_comments_threaded', { p_post_id: postId });
    if (error) throw error;
    return (data || []) as NxComment[];
  }
  const { data, error } = await sb()
    .from('nexus_comments')
    .select('id,post_id,parent_id,body,image_url,created_at,author_user_id,is_ai_author')
    .eq('post_id', postId)
    .eq('is_soft_hidden', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((c: any) => legacyComment(c, communityId, myUid));
}

export async function createComment(
  postId: string, communityId: string, body: string, myUid: string | null, parentId: string | null = null,
): Promise<NxComment> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_create_comment', {
      p_post_id: postId, p_body: body, p_parent_id: parentId, p_image_url: null,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as NxComment;
  }
  const { data, error } = await sb()
    .from('nexus_comments')
    .insert({ post_id: postId, author_user_id: myUid, body, parent_id: parentId })
    .select('id,post_id,parent_id,body,image_url,created_at,author_user_id,is_ai_author')
    .single();
  if (error) throw error;
  return legacyComment(data, communityId, myUid);
}

// ════════════════════════════ RESONANCE ═══════════════════════════════════
/** Toggle resonance. Returns the new impact_count (or null on the legacy path). */
export async function setResonance(postId: string, on: boolean, myUid: string | null): Promise<number | null> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_set_resonance', { p_post_id: postId, p_on: on });
    if (error) throw error;
    return data as number;
  }
  if (on) {
    const { error } = await sb().from('nexus_impacts').insert({ post_id: postId, user_id: myUid, impact_type: 'resonated' });
    if (error && (error as any).code !== '23505') throw error;
  } else {
    await sb().from('nexus_impacts').delete().eq('post_id', postId).eq('user_id', myUid).eq('impact_type', 'resonated');
  }
  return null;
}

// ════════════════════════════ DIRECT MESSAGES ═════════════════════════════
export async function dmInbox(communityId: string | null, myUid: string | null): Promise<NxInboxRow[]> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_dm_inbox', { p_community: communityId });
    if (error) throw error;
    return (data || []) as NxInboxRow[];
  }
  let q = sb().from('nexus_dm_messages')
    .select('community_id,sender_user_id,recipient_user_id,body,image_url,created_at')
    .or('sender_user_id.eq.' + myUid + ',recipient_user_id.eq.' + myUid)
    .order('created_at', { ascending: false }).limit(300);
  if (communityId) q = q.eq('community_id', communityId);
  const { data } = await q;
  const seen: Record<string, number> = {}; const rows: NxInboxRow[] = [];
  (data || []).forEach((m: any) => {
    const other = m.sender_user_id === myUid ? m.recipient_user_id : m.sender_user_id;
    const key = m.community_id + ':' + other;
    if (seen[key]) return; seen[key] = 1;
    rows.push({
      community_id: m.community_id, other_token: other, other_handle: legacyHandleFor(other, m.community_id),
      last_body: m.body || (m.image_url ? '📷 image' : ''), last_at: m.created_at,
      status: 'accepted', is_request: false,
    });
  });
  return rows;
}

export async function dmThread(communityId: string, otherToken: string, myUid: string | null): Promise<NxDM[]> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_dm_thread', { p_community: communityId, p_other_token: otherToken });
    if (error) throw error;
    return (data || []) as NxDM[];
  }
  const { data } = await sb().from('nexus_dm_messages').select('*').eq('community_id', communityId)
    .or('and(sender_user_id.eq.' + myUid + ',recipient_user_id.eq.' + otherToken + '),and(sender_user_id.eq.' + otherToken + ',recipient_user_id.eq.' + myUid + ')')
    .order('created_at', { ascending: true });
  return (data || []).map((m: any) => legacyDM(m, communityId, myUid));
}

export async function sendDM(
  communityId: string, otherToken: string, body: string | null, imageUrl: string | null, myUid: string | null,
): Promise<NxDM> {
  if (NEXUS_PROXY) {
    const { data, error } = await sb().rpc('nexus_send_dm', {
      p_community: communityId, p_recipient_token: otherToken, p_body: body, p_image_url: imageUrl,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as NxDM;
  }
  const { data, error } = await sb().from('nexus_dm_messages')
    .insert({ community_id: communityId, sender_user_id: myUid, recipient_user_id: otherToken, body: body || null, image_url: imageUrl })
    .select('*').single();
  if (error) throw error;
  return legacyDM(data, communityId, myUid);
}

// ── DM accept / decline (message requests, #10) ────────────────────────────
export async function dmAccept(communityId: string, token: string): Promise<void> {
  const { error } = await sb().rpc('nexus_dm_accept', { p_community: communityId, p_other_token: token });
  if (error) throw error;
}
export async function dmDecline(communityId: string, token: string): Promise<void> {
  const { error } = await sb().rpc('nexus_dm_decline', { p_community: communityId, p_other_token: token });
  if (error) throw error;
}

// ════════════════════════════ SAFETY (report / block) ═════════════════════
// Proxy-era RPCs (Phase 1 #1/#2). Token-based — the client never holds a uid.
export async function reportTarget(
  targetType: string, targetId: string | null, communityId: string | null, reason: string, details?: string,
): Promise<void> {
  const { error } = await sb().rpc('nexus_report', {
    p_target_type: targetType, p_target_id: targetId, p_community: communityId, p_reason: reason, p_details: details || null,
  });
  if (error) throw error;
}
export async function blockUser(communityId: string, token: string): Promise<void> {
  const { error } = await sb().rpc('nexus_block', { p_community: communityId, p_other_token: token });
  if (error) throw error;
}
export async function unblockUser(communityId: string, token: string): Promise<void> {
  const { error } = await sb().rpc('nexus_unblock', { p_community: communityId, p_other_token: token });
  if (error) throw error;
}

// ── Tribe moderation (#6): a moderator soft-removes content in their tribe ──
export async function modRemovePost(postId: string): Promise<void> {
  const { error } = await sb().rpc('nexus_mod_remove_post', { p_post_id: postId });
  if (error) throw error;
}
export async function modRemoveComment(commentId: string): Promise<void> {
  const { error } = await sb().rpc('nexus_mod_remove_comment', { p_comment_id: commentId });
  if (error) throw error;
}
export async function modBan(communityId: string, token: string): Promise<void> {
  const { error } = await sb().rpc('nexus_mod_ban', { p_community: communityId, p_other_token: token });
  if (error) throw error;
}

// ── Image moderation (#3): check an uploaded image; FAIL OPEN on any error ──
export async function moderateImage(url: string): Promise<boolean> {
  try {
    const { data } = await sb().auth.getSession();
    const base = (import.meta.env.PUBLIC_SUPABASE_URL as string) || '';
    const anon = (import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string) || '';
    if (!base) return true;
    const token = (data?.session?.access_token) || anon;
    const r = await fetch(base + '/functions/v1/nexus-image-mod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) return true;
    const d = await r.json();
    return d?.allow !== false;
  } catch (e) { return true; }
}

// ════════════════════════════ RECOGNITION (#18/#19) ═══════════════════════
export interface NxStanding {
  streak: { current: number; longest: number; active_today: boolean };
  badges: { key: string; label: string; emoji: string; family: string }[];
}
export async function getStanding(): Promise<NxStanding | null> {
  try {
    const [s, b] = await Promise.all([sb().rpc('nexus_my_streak'), sb().rpc('nexus_my_badges')]);
    if (s.error || b.error) return null;
    return { streak: s.data || { current: 0, longest: 0, active_today: false }, badges: b.data || [] };
  } catch (e) { return null; }
}

// ── #17 "For you" feed (heuristic resonance ranking) ──────────────────────
export interface NxFeedPost extends NxPost { community_name: string; resonance: number; }
export async function getFeed(limit = 24): Promise<NxFeedPost[]> {
  // Throw on a real error so the caller can show "couldn't load — retry" instead
  // of an empty-feed state (a failed load must not masquerade as "nothing here yet").
  const { data, error } = await sb().rpc('nexus_feed', { p_limit: limit });
  if (error) throw error;
  return (data || []) as NxFeedPost[];
}

// ── #31 search posts/discussions ───────────────────────────────────────────
export async function searchPosts(q: string): Promise<NxFeedPost[]> {
  try {
    const { data, error } = await sb().rpc('nexus_search', { p_q: q, p_limit: 20 });
    if (error) return [];
    return (data || []) as NxFeedPost[];
  } catch (e) { return []; }
}

// ── #25/#26 edit + delete your own posts/comments ──────────────────────────
export async function deletePost(id: string): Promise<void> {
  const { error } = await sb().rpc('nexus_delete_post', { p_id: id }); if (error) throw error;
}
export async function deleteComment(id: string): Promise<void> {
  const { error } = await sb().rpc('nexus_delete_comment', { p_id: id }); if (error) throw error;
}
export async function editPost(id: string, title: string | null, body: string): Promise<void> {
  const { error } = await sb().rpc('nexus_edit_post', { p_id: id, p_title: title, p_body: body }); if (error) throw error;
}
export async function editComment(id: string, body: string): Promise<void> {
  const { error } = await sb().rpc('nexus_edit_comment', { p_id: id, p_body: body }); if (error) throw error;
}

// ── #32 tribe discovery (trending public tribes) ──────────────────────────
export interface NxTrending { id: string; name: string; description: string | null; members: number; recent_posts: number; }
export async function getTrending(): Promise<NxTrending[]> {
  try {
    const { data, error } = await sb().rpc('nexus_trending_tribes', { p_limit: 8 });
    if (error) return [];
    return (data || []) as NxTrending[];
  } catch (e) { return []; }
}

// ════════════════════════════ CRISIS SUPPORT (#5) ═════════════════════════
// Author-facing, owner-RLS, runs in BOTH modes (the classifier is a DB trigger).
export async function getCrisisSupport(): Promise<{ id: string } | null> {
  try {
    const { data } = await sb().from('nexus_crisis_events')
      .select('id').is('acknowledged_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data ? { id: (data as { id: string }).id } : null;
  } catch (e) { return null; }
}
export async function ackCrisis(id: string): Promise<void> {
  try {
    await sb().from('nexus_crisis_events')
      .update({ acknowledged_at: new Date().toISOString() }).eq('id', id);
  } catch (e) { /* best-effort */ }
}

// ── Removal notices (#11): a moderator/admin removed your content ──────────
export async function getRemovalNotices(): Promise<number> {
  try {
    const { count } = await sb().from('nexus_content_notices')
      .select('id', { count: 'exact', head: true }).is('acknowledged_at', null);
    return count || 0;
  } catch (e) { return 0; }
}
export async function ackRemovalNotices(): Promise<void> {
  try {
    await sb().from('nexus_content_notices')
      .update({ acknowledged_at: new Date().toISOString() }).is('acknowledged_at', null);
  } catch (e) { /* best-effort */ }
}

// ── legacy → normalised mappers (raw uid stays internal as the "token") ─────
function legacyPost(p: any, communityId: string, myUid: string | null, myResonated: boolean): NxPost {
  const uid = p.author_user_id || '';
  const blak = !!p.is_ai_author || uid === BLAK_UID;
  return {
    id: p.id, community_id: p.community_id || communityId, is_ai_author: blak,
    title: p.title ?? null, body: p.body ?? null, image_url: p.image_url ?? null,
    impact_count: p.impact_count || 0, comment_count: p.comment_count || 0, created_at: p.created_at,
    author_token: uid, author_handle: blak ? 'Blak' : legacyHandleFor(uid, p.community_id || communityId),
    is_mine: !!myUid && uid === myUid, my_resonated: myResonated,
  };
}
function legacyComment(c: any, communityId: string, myUid: string | null): NxComment {
  const uid = c.author_user_id || '';
  const blak = !!c.is_ai_author || uid === BLAK_UID;
  return {
    id: c.id, post_id: c.post_id, parent_id: c.parent_id ?? null, is_ai_author: blak, body: c.body ?? null, image_url: c.image_url ?? null,
    created_at: c.created_at, author_token: uid,
    author_handle: blak ? 'Blak' : legacyHandleFor(uid, communityId), is_mine: !!myUid && uid === myUid,
  };
}
function legacyDM(m: any, communityId: string, myUid: string | null): NxDM {
  const mine = m.sender_user_id === myUid;
  const other = mine ? m.recipient_user_id : m.sender_user_id;
  return {
    id: m.id, community_id: m.community_id || communityId, body: m.body ?? null, image_url: m.image_url ?? null,
    created_at: m.created_at, is_mine: mine, other_token: other, other_handle: legacyHandleFor(other, m.community_id || communityId),
  };
}
