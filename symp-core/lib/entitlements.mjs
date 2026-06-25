// Entitlements — the server-side feature gate. Resolves what a user is allowed
// to do from their active subscription's plan features + any ad-hoc grants,
// falling back to the 'free' plan. Provider-agnostic: billing webhooks just
// upsert user_subscriptions; this reads the result.
//
// Reads via the service-role REST API (bypasses RLS) so it works from any
// Netlify function. Fail-OPEN to the free plan on error (never block a request
// because the gate is unreachable) — paid features simply won't be granted.

const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(path) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
            headers: {
                'apikey':        SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Accept':        'application/json',
            },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) { return null; }
}

const truthy = (v) => v === true || (typeof v === 'number' && v > 0);

/**
 * Resolve a user's effective plan id ('free' if none/active sub missing).
 * @returns {Promise<string>}
 */
export async function getPlanId(userId) {
    if (!userId) return 'free';
    const rows = await sb(`user_subscriptions?user_id=eq.${userId}&status=in.(active,trialing)&select=plan_id&limit=1`);
    return (Array.isArray(rows) && rows[0]?.plan_id) || 'free';
}

/**
 * Does the user have a feature? Checks active grants, then plan features.
 * @returns {Promise<boolean>}
 */
export async function hasEntitlement(userId, feature) {
    if (!userId || !feature) return false;
    const nowIso = new Date().toISOString();
    const grants = await sb(`entitlement_grants?user_id=eq.${userId}&feature=eq.${encodeURIComponent(feature)}&select=expires_at`);
    if (Array.isArray(grants) && grants.some((g) => !g.expires_at || g.expires_at > nowIso)) return true;

    const planId = await getPlanId(userId);
    const plans = await sb(`billing_plans?plan_id=eq.${encodeURIComponent(planId)}&select=features`);
    const feats = (Array.isArray(plans) && plans[0]?.features) || {};
    return truthy(feats[feature]);
}

/**
 * Numeric quota for a feature (max of grant + plan). 0 if none.
 * @returns {Promise<number>}
 */
export async function entitlementQuota(userId, feature) {
    if (!userId || !feature) return 0;
    const nowIso = new Date().toISOString();
    const grants = await sb(`entitlement_grants?user_id=eq.${userId}&feature=eq.${encodeURIComponent(feature)}&select=quota,expires_at`);
    let gMax = 0;
    if (Array.isArray(grants)) for (const g of grants) {
        if ((!g.expires_at || g.expires_at > nowIso) && Number(g.quota) > gMax) gMax = Number(g.quota);
    }
    const planId = await getPlanId(userId);
    const plans = await sb(`billing_plans?plan_id=eq.${encodeURIComponent(planId)}&select=features`);
    const feats = (Array.isArray(plans) && plans[0]?.features) || {};
    const planQ = typeof feats[feature] === 'number' ? feats[feature] : 0;
    return Math.max(gMax, planQ);
}
