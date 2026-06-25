// Entitlements — client-side feature gate. Thin wrappers over the RPCs
// (has_entitlement / entitlement_quota / current_plan), all scoped to the
// signed-in user server-side. Fail-safe: returns false / free on any error so
// the UI degrades to the free experience rather than breaking.

type SB = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }> } | null;

export type Plan = {
    plan_id: string;
    name: string | null;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
};

/** Does the current user have this feature? */
export async function hasEntitlement(supabase: SB, feature: string): Promise<boolean> {
    if (!supabase || !feature) return false;
    try {
        const { data, error } = await supabase.rpc('has_entitlement', { p_feature: feature });
        return !error && data === true;
    } catch { return false; }
}

/** Numeric quota for a feature (0 if none). */
export async function entitlementQuota(supabase: SB, feature: string): Promise<number> {
    if (!supabase || !feature) return 0;
    try {
        const { data, error } = await supabase.rpc('entitlement_quota', { p_feature: feature });
        return error ? 0 : (Number(data) || 0);
    } catch { return 0; }
}

/** The current user's plan (defaults to 'free'). */
export async function currentPlan(supabase: SB): Promise<Plan> {
    const fallback: Plan = { plan_id: 'free', name: 'Free', status: 'active', current_period_end: null, cancel_at_period_end: false };
    if (!supabase) return fallback;
    try {
        const { data, error } = await supabase.rpc('current_plan');
        const row = Array.isArray(data) ? data[0] : data;
        if (error || !row) return fallback;
        return { ...fallback, ...row };
    } catch { return fallback; }
}
