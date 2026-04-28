// Admin dashboard backing endpoints. All read-only; admin-role enforced.
//
//   GET /api/symp/v1/admin/overview
//        — KPI strip: 7-day actives, today's AI sessions, vault profiles,
//          credits in circulation, distress signals last 24h, action loop
//          pending count, nexus posts last 24h.
//
//   GET /api/symp/v1/admin/users/list?q=&limit=&offset=
//        — paginated user list with credit balance + vault status badges.
//          Excludes admin role.
//
//   GET /api/symp/v1/admin/users/detail?target_user_id=
//        — drill-in: profile + vault analysis + last 14 journals + persona
//          state + vibe state + credits wallet/history.
//
//   GET /api/symp/v1/admin/symp-status
//        — inference router config (provider/model per task), action loop
//          pending, recent diagnostic corrections, AI participant activity.
//
//   GET /api/symp/v1/admin/recent-activity?limit=
//        — recent symp_api_access_log + recent journals (cross-user feed).
//
// Auth: Blaksyd proxy stamps `user_id` from JWT. We re-verify
// `profiles.role === 'admin'` per request — defence in depth.

import {
    corsPreflight, getRequestId, validateApiKey, jsonSuccess, jsonError, logAccess,
} from '../../symp-core/lib/middleware.mjs';
import { isAdmin, getAccountSummaryForAdmin } from '../../symp-core/lib/credits.mjs';
import { inferenceDiagnostics } from '../../symp-core/lib/inference.mjs';
import {
    fetchVaultProfile, fetchRecentJournals, fetchVibeState, fetchPersonaState,
    fetchUserActionRowsLast,
} from '../../symp-core/lib/supabase.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES } = SympContract;

// ── Lightweight service-role REST helper, mirrors the pattern in supabase.mjs ──
const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(path) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, data: null };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
            'apikey':        SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
            'Prefer':        'count=exact',
        },
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* fall through */ }
    const total = Number(res.headers.get('content-range')?.split('/')?.[1]) || null;
    return { ok: res.ok, status: res.status, data, total };
}

async function countWhere(table, filter = '') {
    const r = await sb(`${table}?select=id&limit=1${filter ? '&' + filter : ''}`);
    return r.total || 0;
}

async function requireAdmin({ adminId, requestId, endpoint, t0 }) {
    if (!adminId) {
        logAccess({ requestId, endpoint, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return jsonError(ERROR_CODES.INVALID_API_KEY, 'authenticated user_id missing', 401, requestId);
    }
    const ok = await isAdmin(adminId).catch(() => false);
    if (!ok) {
        logAccess({ requestId, endpoint, userId: adminId, statusCode: 403, latencyMs: Date.now() - t0, errorCode: 'FORBIDDEN' });
        return jsonError(ERROR_CODES.FORBIDDEN, 'admin role required', 403, requestId);
    }
    return null;
}

// ── /admin/overview ────────────────────────────────────────────────────────
async function handleOverview() {
    const now      = new Date();
    const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo  = new Date(now.getTime() - 7  * 86400000).toISOString();
    const dayAgo   = new Date(now.getTime() - 24 * 3600000).toISOString();

    // Run independent counts in parallel.
    const [
        users7d, vaultCount, vibesActive, journalsToday, postsDay, distressDay,
        actionPending, creditsAgg, apiCalls24h,
    ] = await Promise.all([
        countWhere('profiles',                   `created_at=gte.${weekAgo}&role=neq.admin`),
        countWhere('symp_vault_profiles'),
        countWhere('symp_vibe_state',            `updated_at=gte.${weekAgo}`),
        countWhere('symp_daily_journals',        `journal_date=gte.${todayIso.slice(0,10)}`),
        countWhere('nexus_posts',                `created_at=gte.${dayAgo}`),
        countWhere('nexus_posts',                `risk_level=in.(high,critical)&created_at=gte.${dayAgo}`),
        countWhere('symp_action_loop',           `status=eq.pending`),
        sb('symp_credit_wallets?select=current_credits,lifetime_granted,lifetime_spent'),
        countWhere('symp_api_access_log',        `created_at=gte.${dayAgo}`),
    ]);

    let creditsInCirc = 0, lifetimeGranted = 0, lifetimeSpent = 0;
    if (creditsAgg.ok && Array.isArray(creditsAgg.data)) {
        for (const w of creditsAgg.data) {
            creditsInCirc   += Number(w.current_credits)  || 0;
            lifetimeGranted += Number(w.lifetime_granted) || 0;
            lifetimeSpent   += Number(w.lifetime_spent)   || 0;
        }
    }

    return {
        kpis: {
            new_users_7d:         users7d,
            vault_profiles_total: vaultCount,
            vibes_active_7d:      vibesActive,
            journals_today:       journalsToday,
            nexus_posts_24h:      postsDay,
            distress_posts_24h:   distressDay,
            action_loop_pending:  actionPending,
            credits_in_circulation: creditsInCirc,
            credits_lifetime_granted: lifetimeGranted,
            credits_lifetime_spent:   lifetimeSpent,
            api_calls_24h:        apiCalls24h,
        },
        generated_at: new Date().toISOString(),
    };
}

// ── /admin/users/list ──────────────────────────────────────────────────────
async function handleUsersList({ q, limit, offset }) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 25));
    const off = Math.max(0, Number(offset) || 0);
    let path = `profiles?role=neq.admin&order=created_at.desc&limit=${cap}&offset=${off}` +
        `&select=id,full_name,email,role,avatar_url,created_at,dob,gender`;
    if (q) {
        const safe = String(q).replace(/[(),]/g, ' ').slice(0, 80);
        path = `profiles?role=neq.admin&order=created_at.desc&limit=${cap}&offset=${off}` +
            `&select=id,full_name,email,role,avatar_url,created_at,dob,gender` +
            `&or=(full_name.ilike.*${encodeURIComponent(safe)}*,email.ilike.*${encodeURIComponent(safe)}*)`;
    }
    const r = await sb(path);
    const rows = (r.ok && Array.isArray(r.data)) ? r.data : [];
    if (!rows.length) return { users: [], total: r.total || 0 };

    const ids = rows.map(x => x.id);
    const inList = ids.map(encodeURIComponent).join(',');
    const [walletRes, vaultRes, vibeRes] = await Promise.all([
        sb(`symp_credit_wallets?user_id=in.(${inList})&select=user_id,current_credits`),
        sb(`symp_vault_profiles?user_id=in.(${inList})&select=user_id,last_analyzed_at`),
        sb(`symp_vibe_state?user_id=in.(${inList})&select=user_id,vibe_label,intensity,updated_at`),
    ]);
    const wByU = new Map();  if (walletRes.ok && Array.isArray(walletRes.data)) for (const w of walletRes.data) wByU.set(w.user_id, w);
    const vByU = new Map();  if (vaultRes.ok  && Array.isArray(vaultRes.data))  for (const v of vaultRes.data)  vByU.set(v.user_id, v);
    const sByU = new Map();  if (vibeRes.ok   && Array.isArray(vibeRes.data))   for (const s of vibeRes.data)   sByU.set(s.user_id, s);

    const users = rows.map(p => ({
        id:               p.id,
        full_name:        p.full_name,
        email:            p.email,
        avatar_url:       p.avatar_url,
        created_at:       p.created_at,
        dob:              p.dob,
        gender:           p.gender,
        credits:          wByU.get(p.id)?.current_credits ?? 0,
        last_analyzed_at: vByU.get(p.id)?.last_analyzed_at ?? null,
        vibe_label:       sByU.get(p.id)?.vibe_label   ?? null,
        vibe_intensity:   sByU.get(p.id)?.intensity    ?? null,
        vibe_updated_at:  sByU.get(p.id)?.updated_at   ?? null,
    }));
    return { users, total: r.total || users.length };
}

// ── /admin/users/detail ────────────────────────────────────────────────────
async function handleUserDetail(targetUserId) {
    if (!targetUserId) return { ok: false, error: 'target_user_id required' };

    const [
        profileRes, vault, journals, vibe, persona, actionRows, credits,
    ] = await Promise.all([
        sb(`profiles?id=eq.${encodeURIComponent(targetUserId)}` +
            `&select=id,full_name,email,role,avatar_url,bio,user_memory,dob,gender,created_at,updated_at`),
        fetchVaultProfile(targetUserId).catch(() => null),
        fetchRecentJournals(targetUserId, 14).catch(() => []),
        fetchVibeState(targetUserId).catch(() => null),
        fetchPersonaState(targetUserId).catch(() => null),
        fetchUserActionRowsLast(targetUserId, 14).catch(() => []),
        getAccountSummaryForAdmin(targetUserId, { historyLimit: 50 }).catch(() => ({ wallet: null, history: [] })),
    ]);

    return {
        profile:       (profileRes.ok && Array.isArray(profileRes.data) && profileRes.data[0]) || null,
        vault,
        journals,
        vibe,
        persona,
        action_rows:   actionRows,
        credits,
    };
}

// ── /admin/symp-status ─────────────────────────────────────────────────────
async function handleSympStatus() {
    const inference = inferenceDiagnostics();
    const dayAgo    = new Date(Date.now() - 24 * 3600000).toISOString();
    const [
        actionPending, actionDone24h, actionFailed24h,
        diagRecent, aiCommentsDay, tldrCount, errors24h,
    ] = await Promise.all([
        countWhere('symp_action_loop', `status=eq.pending`),
        countWhere('symp_action_loop', `status=eq.done&fired_at=gte.${dayAgo}`),
        countWhere('symp_action_loop', `status=eq.failed&fired_at=gte.${dayAgo}`),
        sb(`symp_diagnostic_corrections?order=created_at.desc&limit=10&select=id,user_id,kind,note,created_at`),
        countWhere('nexus_comments',   `is_ai_author=eq.true&created_at=gte.${dayAgo}`),
        countWhere('nexus_posts',      `ai_tldr=not.is.null`),
        countWhere('symp_api_access_log', `status_code=gte.500&created_at=gte.${dayAgo}`),
    ]);

    return {
        inference,
        action_loop: {
            pending:        actionPending,
            done_24h:       actionDone24h,
            failed_24h:     actionFailed24h,
        },
        nexus_ai: {
            ai_comments_24h: aiCommentsDay,
            tldr_total:      tldrCount,
        },
        recent_diagnostic_corrections: (diagRecent.ok && Array.isArray(diagRecent.data)) ? diagRecent.data : [],
        api_errors_24h: errors24h,
        generated_at:   new Date().toISOString(),
    };
}

// ── /admin/recent-activity ─────────────────────────────────────────────────
async function handleRecentActivity({ limit }) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 30));
    const [api, journals, posts] = await Promise.all([
        sb(`symp_api_access_log?order=created_at.desc&limit=${cap}` +
            `&select=request_id,endpoint,user_id,status_code,latency_ms,error_code,created_at`),
        sb(`symp_daily_journals?order=updated_at.desc&limit=${Math.min(cap, 25)}` +
            `&select=id,user_id,journal_date,entry_type,updated_at`),
        sb(`nexus_posts?order=created_at.desc&limit=${Math.min(cap, 25)}` +
            `&select=id,community_id,author_user_id,title,risk_level,impact_count,comment_count,created_at`),
    ]);
    return {
        api_access:   (api.ok       && Array.isArray(api.data))       ? api.data       : [],
        journals:     (journals.ok  && Array.isArray(journals.data))  ? journals.data  : [],
        nexus_posts:  (posts.ok     && Array.isArray(posts.data))     ? posts.data     : [],
    };
}

// ── Router ─────────────────────────────────────────────────────────────────
export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();

    const t0        = Date.now();
    const requestId = getRequestId(req);
    const url       = new URL(req.url);
    const path      = url.pathname;

    const auth = validateApiKey(req, requestId);
    if (!auth.ok) {
        logAccess({ requestId, endpoint: path, statusCode: 401, latencyMs: Date.now() - t0, errorCode: 'INVALID_API_KEY' });
        return auth.response;
    }

    if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

    const adminId = url.searchParams.get('user_id');     // proxy-stamped from JWT
    const guard   = await requireAdmin({ adminId, requestId, endpoint: path, t0 });
    if (guard) return guard;

    try {
        let payload = null;

        if      (path.endsWith('/admin/overview'))         payload = await handleOverview();
        else if (path.endsWith('/admin/users/list'))       payload = await handleUsersList({
            q:      url.searchParams.get('q') || '',
            limit:  url.searchParams.get('limit'),
            offset: url.searchParams.get('offset'),
        });
        else if (path.endsWith('/admin/users/detail'))     payload = await handleUserDetail(url.searchParams.get('target_user_id'));
        else if (path.endsWith('/admin/symp-status'))      payload = await handleSympStatus();
        else if (path.endsWith('/admin/recent-activity'))  payload = await handleRecentActivity({
            limit: url.searchParams.get('limit'),
        });
        else return new Response('Not Found', { status: 404 });

        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 200, latencyMs: Date.now() - t0 });
        return jsonSuccess(payload || {}, requestId);
    } catch (e) {
        logAccess({ requestId, endpoint: path, userId: adminId, statusCode: 500, latencyMs: Date.now() - t0, errorCode: 'INTERNAL_ERROR' });
        return jsonError(ERROR_CODES.INTERNAL_ERROR, `admin endpoint failed: ${e.message || e}`, 500, requestId);
    }
};

export const config = {
    path: [
        '/api/symp/v1/admin/overview',
        '/api/symp/v1/admin/users/list',
        '/api/symp/v1/admin/users/detail',
        '/api/symp/v1/admin/symp-status',
        '/api/symp/v1/admin/recent-activity',
    ],
};
