// Server-side analytics sink (Node / Netlify functions). Writes to the same
// public.analytics_events table via the service role, bypassing RLS. Use for
// events that originate server-side (e.g. session_started, ai_turn, checkout).
//
// Fire-and-forget + fully fail-silent: analytics must NEVER break a request.
// Gated on ANALYTICS_SERVER=1 (server flag, separate from the client's
// PUBLIC_ANALYTICS) so it ships dark until you opt in.

const SUPABASE_URL              = process.env.SUPABASE_URL              || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ENABLED                   = process.env.ANALYTICS_SERVER === '1';

/**
 * Record a server-side event. Never throws, never blocks the caller meaningfully.
 * @param {string} event
 * @param {{userId?:string|null, props?:object, path?:string, sessionId?:string}} [opts]
 * @returns {Promise<void>}
 */
export async function trackServer(event, opts = {}) {
    if (!ENABLED || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !event) return;
    const row = {
        user_id:    opts.userId || null,
        event:      String(event).slice(0, 120),
        props:      opts.props && typeof opts.props === 'object' ? opts.props : {},
        path:       opts.path || null,
        session_id: opts.sessionId || null,
    };
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/analytics_events`, {
            method: 'POST',
            headers: {
                'apikey':        SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        'return=minimal',
            },
            body: JSON.stringify(row),
        });
    } catch (_) { /* fail-silent by design */ }
}
