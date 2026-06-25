// Product analytics + client error capture — one uniform surface.
//
// `track(event, props)` is safe to call from anywhere. It:
//   1. writes a first-party row to public.analytics_events (signed-in users),
//      gated on PUBLIC_ANALYTICS — queryable in Supabase with no external dep;
//   2. forwards to PostHog / Plausible if their PUBLIC_* keys are set.
// Everything degrades to a no-op when nothing is configured, so this can ship
// dark and light up the moment a flag/key is added (see the capability map).
//
// Privacy: never pass secrets or free-text PII in `props` — keep to event
// names + coarse dimensions (e.g. { pillar:'minit', mode:'instant' }).

type Props = Record<string, unknown>;
type SB = { auth: { getSession: () => Promise<{ data: { session: any } }> }; from: (t: string) => any } | null;

const env = (import.meta as any).env || {};
const FIRST_PARTY = String(env.PUBLIC_ANALYTICS || '') === '1';
const POSTHOG_KEY = env.PUBLIC_POSTHOG_KEY || '';
const POSTHOG_HOST = env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
const PLAUSIBLE_DOMAIN = env.PUBLIC_PLAUSIBLE_DOMAIN || '';

let _sb: SB = null;
let _uidPromise: Promise<string | null> | null = null;
let _sessionId = '';

function sessionId(): string {
    if (_sessionId) return _sessionId;
    try {
        const k = 'bx_an_sid';
        let v = sessionStorage.getItem(k);
        if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(k, v); }
        _sessionId = v;
    } catch { _sessionId = 'nostore'; }
    return _sessionId;
}

async function currentUid(): Promise<string | null> {
    if (!_sb) return null;
    if (!_uidPromise) {
        _uidPromise = _sb.auth.getSession()
            .then((r) => r?.data?.session?.user?.id || null)
            .catch(() => null);
    }
    return _uidPromise;
}

/** Record an event. Fire-and-forget; never throws. */
export function track(event: string, props: Props = {}): void {
    try {
        const w = window as any;
        if (POSTHOG_KEY && w.posthog?.capture) { try { w.posthog.capture(event, props); } catch { /* */ } }
        if (PLAUSIBLE_DOMAIN && typeof w.plausible === 'function') { try { w.plausible(event, { props }); } catch { /* */ } }
        if (FIRST_PARTY && _sb) {
            currentUid().then((uid) => {
                if (!uid) return; // RLS requires user_id = auth.uid(); skip anon
                try {
                    _sb!.from('analytics_events').insert({
                        user_id: uid,
                        event,
                        props,
                        path: location.pathname,
                        session_id: sessionId(),
                    }).then(() => {}, () => {});
                } catch { /* */ }
            });
        }
    } catch { /* analytics must never break the app */ }
}

/** Convenience: a page view. */
export function pageview(extra: Props = {}): void {
    track('$pageview', { path: location.pathname, ...extra });
}

function loadPosthog(): void {
    const w = window as any;
    if (!POSTHOG_KEY || w.posthog) return;
    const host = POSTHOG_HOST.replace(/\/$/, '');
    const s = document.createElement('script');
    s.src = host + '/static/array.js';
    s.async = true;
    s.onload = () => { try { w.posthog?.init?.(POSTHOG_KEY, { api_host: host, capture_pageview: false, persistence: 'localStorage' }); } catch { /* */ } };
    document.head.appendChild(s);
}

function loadPlausible(): void {
    const w = window as any;
    if (!PLAUSIBLE_DOMAIN || w.__bxPlausible) return;
    w.__bxPlausible = true;
    w.plausible = w.plausible || function () { (w.plausible.q = w.plausible.q || []).push(arguments); };
    const s = document.createElement('script');
    s.defer = true;
    s.setAttribute('data-domain', PLAUSIBLE_DOMAIN);
    s.src = 'https://plausible.io/js/script.js';
    document.head.appendChild(s);
}

/**
 * Initialise analytics for the current page. Pass the Supabase client (may be
 * null). Loads any configured provider and records the initial page view.
 * No-op when nothing is configured.
 */
export function initAnalytics(supabase: SB): void {
    _sb = supabase;
    if (!FIRST_PARTY && !POSTHOG_KEY && !PLAUSIBLE_DOMAIN) return; // fully dark
    try {
        loadPosthog();
        loadPlausible();
        pageview();
    } catch { /* */ }
}

/**
 * Lightweight client error capture → first-party sink (and PostHog if loaded).
 * Capped + deduped so a render loop can't flood the table. Sentry, if ever
 * added, would replace/augment this via PUBLIC_SENTRY_DSN.
 */
export function initErrorMonitoring(supabase: SB): void {
    _sb = _sb || supabase;
    if (!FIRST_PARTY && !POSTHOG_KEY) return; // nowhere to send → skip
    let count = 0;
    const seen = new Set<string>();
    const cap = 10;
    const report = (kind: string, message: string, extra: Props) => {
        if (count >= cap) return;
        const sig = kind + '|' + message.slice(0, 120);
        if (seen.has(sig)) return;
        seen.add(sig); count++;
        track('client_error', { kind, message: message.slice(0, 300), ...extra });
    };
    try {
        window.addEventListener('error', (e: any) => {
            report('error', String(e?.message || 'error'), { source: e?.filename, line: e?.lineno });
        });
        window.addEventListener('unhandledrejection', (e: any) => {
            const r = e?.reason;
            report('unhandledrejection', String(r?.message || r || 'rejection'), {});
        });
    } catch { /* */ }
}
