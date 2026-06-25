// Capability registry — the single source of truth for "what is wired up".
//
// Blaksyd's growth is mostly gated on external providers (push, billing, voice
// relay, paid LLM, moderation, analytics). Rather than scatter `process.env.X`
// checks across dozens of files, every capability is declared ONCE here with:
//   - the env var(s) that activate it,
//   - what it unlocks (plain English),
//   - WHERE the key must live (Netlify / Supabase Edge / Cloud Run bridge).
//
// A capability is "enabled" the moment its keys are present — no code change.
// This module is pure + side-effect free: pass any env accessor (process.env,
// Deno.env.get, a test stub) and it computes the same map. It NEVER returns a
// secret value — only the NAMES of what is set/missing — so the result is safe
// to surface in an admin panel.
//
// Edge (Deno) runtime: a thin mirror at supabase/functions/_shared/capabilities.ts
// is added alongside the first edge consumer (moderation fail-closed / push
// dispatch); it reuses this same SPEC shape. Keep them in sync when that lands.

/**
 * @typedef {Object} CapabilitySpec
 * @property {string}  id        dotted id, e.g. 'push.web'
 * @property {string}  group     UI grouping, e.g. 'Notifications'
 * @property {string}  label     human label
 * @property {string}  unlocks   what turning this on enables
 * @property {string}  where     runtime where the key(s) must be set
 * @property {Array<string|string[]>} need
 *   each element must be satisfied for the capability to be enabled.
 *   - a string  → that env var must be set (non-empty)
 *   - an array  → at least ONE of those env vars must be set (anyOf)
 */

/** @type {CapabilitySpec[]} */
export const CAPABILITY_SPEC = [
    // ── Notifications & messaging (primitive: notify() queue) ──────────────
    { id: 'push.web', group: 'Notifications', label: 'Web push (VAPID)', where: 'Supabase Edge (push-send) + Netlify (Blak crons)',
      // Public key is baked into src/lib/push.mjs (safe to embed); only the
      // private key + subject are secret. NOTE: two senders today use different
      // names for the SAME keypair — the edge push-send fn uses VAPID_PRIVATE_KEY,
      // the Node proactive crons use VAPID_PRIVATE_PKCS8. Set both to cover both
      // paths until they're unified.
      unlocks: 'Proactive Blak / Minit / Nexus / Persona reach while the web app is closed.',
      need: ['VAPID_SUBJECT', ['VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_PKCS8']] },
    { id: 'push.native', group: 'Notifications', label: 'Native push (APNs / FCM)', where: 'Netlify + Supabase Edge',
      unlocks: 'iOS / Android push once the apps are wrapped (Capacitor).',
      need: [['APNS_KEY_P8', 'FCM_SERVER_KEY', 'FCM_SERVICE_ACCOUNT']] },
    { id: 'email', group: 'Notifications', label: 'Transactional email', where: 'Netlify',
      unlocks: 'Email notifications, Minit callbacks, receipts, account mail.',
      need: [['RESEND_API_KEY', 'POSTMARK_TOKEN']] },
    { id: 'messaging.whatsapp', group: 'Notifications', label: 'WhatsApp', where: 'Netlify + Supabase Edge',
      unlocks: 'WhatsApp OTP + Minit "a listener is free" callbacks.',
      need: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] },
    { id: 'messaging.sms', group: 'Notifications', label: 'SMS (Twilio)', where: 'Netlify',
      unlocks: 'SMS OTP / fallback alerts.',
      need: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },

    // ── Billing (primitive: entitlements) ──────────────────────────────────
    { id: 'billing.stripe', group: 'Billing', label: 'Stripe', where: 'Netlify',
      unlocks: 'Subscriptions + Minit pay-per-session (global cards).',
      need: ['STRIPE_SECRET_KEY'] },
    { id: 'billing.razorpay', group: 'Billing', label: 'Razorpay', where: 'Netlify',
      unlocks: 'Subscriptions + pay-per-session (India / UPI).',
      need: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] },

    // ── Voice ──────────────────────────────────────────────────────────────
    { id: 'voice.turn', group: 'Voice', label: 'TURN relay', where: 'Netlify (ice-servers fn)',
      unlocks: 'Reliable WebRTC connect for Minit + group calls behind NAT/firewalls.',
      need: [['TURN_URLS', 'METERED_API_KEY']] },
    { id: 'voice.livekit', group: 'Voice', label: 'LiveKit SFU', where: 'Netlify + blak-agent (Cloud Run)',
      unlocks: 'Group voice rooms + Blak speaking in-call.',
      need: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] },
    { id: 'voice.clone', group: 'Voice', label: 'Persona voice clone', where: 'Netlify (Modal GPU URLs)',
      unlocks: 'Own-voice persona calls (clone-social).',
      need: [['VOICE_INFER_URL', 'VOICE_FT_API_URL']] },

    // ── Intelligence (primitive: LLM router) ───────────────────────────────
    { id: 'llm.primary', group: 'Intelligence', label: 'Primary LLM (Azure)', where: 'Netlify + Supabase Edge',
      unlocks: 'High-quality chat with no shared free-tier rate wall.',
      need: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'] },
    { id: 'llm.paid', group: 'Intelligence', label: 'Paid OSS LLM tier', where: 'Netlify + Supabase Edge',
      unlocks: 'Scale past the Groq free ~12k tok/min ceiling (the #1 scale bottleneck).',
      need: [['OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'DEEPINFRA_API_KEY']] },
    { id: 'llm.floor', group: 'Intelligence', label: 'Free LLM floor (Groq)', where: 'Netlify + Supabase Edge',
      unlocks: 'Zero-cost downtime floor for chat + background work.',
      need: ['GROQ_API_KEY'] },

    // ── Trust & safety ──────────────────────────────────────────────────────
    { id: 'moderation.image', group: 'Trust & safety', label: 'Image moderation', where: 'Supabase Edge (nexus-image-mod)',
      // A provider gives real verdicts; set MODERATION_MODE=closed to also block
      // when no verdict is available (fail-closed). Without a key it fails open.
      unlocks: 'Real UGC image scanning + the option to fail CLOSED on no verdict.',
      need: [['OPENAI_API_KEY', 'GEMINI_API_KEY']] },

    // ── Observability ─────────────────────────────────────────────────────
    { id: 'analytics', group: 'Observability', label: 'Product analytics', where: 'Netlify (PUBLIC_)',
      // PUBLIC_ANALYTICS=1 turns on the zero-dependency first-party sink
      // (public.analytics_events); a provider key additionally forwards events.
      unlocks: 'Funnels, retention, feature-usage — stop flying blind at scale.',
      need: [['PUBLIC_ANALYTICS', 'PUBLIC_POSTHOG_KEY', 'PUBLIC_PLAUSIBLE_DOMAIN', 'PUBLIC_GA_MEASUREMENT_ID']] },
    { id: 'errors', group: 'Observability', label: 'Error monitoring', where: 'Netlify (PUBLIC_) + Edge',
      unlocks: 'Server + client crash/error capture.',
      need: [['SENTRY_DSN', 'PUBLIC_SENTRY_DSN']] },

    // ── Integrations (primitive: provider registry) ────────────────────────
    { id: 'integrations.gmail', group: 'Integrations', label: 'Gmail', where: 'Supabase Edge',
      unlocks: 'Receipt-learning + act-on-mail.',
      need: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
    { id: 'integrations.spotify', group: 'Integrations', label: 'Spotify', where: 'Supabase Edge',
      unlocks: 'Music context + control.',
      need: [['SPOTIFY_OAUTH_CLIENT_ID', 'SPOTIFY_CLIENT_ID'], ['SPOTIFY_OAUTH_CLIENT_SECRET', 'SPOTIFY_CLIENT_SECRET']] },
    { id: 'integrations.ondc', group: 'Integrations', label: 'ONDC (cabs)', where: 'Netlify',
      unlocks: 'Headless cab booking (rides-first).',
      need: ['ONDC_SUBSCRIBER_ID'] },

    // ── Community (Nexus) ───────────────────────────────────────────────────
    { id: 'nexus.proxy', group: 'Community', label: 'Nexus server-proxy', where: 'Netlify (PUBLIC_NEXUS_PROXY)',
      unlocks: 'Anonymized feed + report/block/mod; closes the author-uid leak.',
      need: [['PUBLIC_NEXUS_PROXY']] },
    { id: 'nexus.blak', group: 'Community', label: 'Nexus Blak peer', where: 'Supabase Edge secret',
      unlocks: 'Blak participates as a warm peer in tribes + rooms.',
      need: ['NEXUS_BLAK_CRON_SECRET'] },
];

/** Default env accessor for the Node (Netlify / symp-core) runtime. */
const nodeEnv = (k) => {
    const v = (typeof process !== 'undefined' && process.env) ? process.env[k] : undefined;
    return v == null || v === '' ? undefined : v;
};

/** Is a single `need` element satisfied by the given env accessor? */
function elementSatisfied(el, get) {
    if (Array.isArray(el)) return el.some((k) => !!get(k)); // anyOf
    return !!get(el);
}

/** Names still missing for an unsatisfied element (for the "what to set" hint). */
function elementMissing(el) {
    return Array.isArray(el) ? `one of (${el.join(' | ')})` : el;
}

/**
 * Resolve the full capability map against an env accessor.
 * @param {(k:string)=>(string|undefined)} [get] defaults to process.env
 * @returns {Array<CapabilitySpec & {enabled:boolean, missing:string[]}>}
 */
export function capabilities(get = nodeEnv) {
    return CAPABILITY_SPEC.map((c) => {
        const missing = [];
        for (const el of c.need) {
            if (!elementSatisfied(el, get)) missing.push(elementMissing(el));
        }
        return { ...c, enabled: missing.length === 0, missing };
    });
}

/** Boolean check for one capability id. Unknown id → false. */
export function isEnabled(id, get = nodeEnv) {
    const c = CAPABILITY_SPEC.find((x) => x.id === id);
    if (!c) return false;
    return c.need.every((el) => elementSatisfied(el, get));
}

/** Flat { id: boolean } map — handy for client hydration / feature flags. */
export function capabilityMap(get = nodeEnv) {
    const out = {};
    for (const c of CAPABILITY_SPEC) out[c.id] = c.need.every((el) => elementSatisfied(el, get));
    return out;
}

/** Counts + per-group rollup for a dashboard header. */
export function capabilitySummary(get = nodeEnv) {
    const caps = capabilities(get);
    const byGroup = {};
    for (const c of caps) {
        const g = (byGroup[c.group] ||= { total: 0, enabled: 0 });
        g.total += 1;
        if (c.enabled) g.enabled += 1;
    }
    return {
        total: caps.length,
        enabled: caps.filter((c) => c.enabled).length,
        byGroup,
    };
}
