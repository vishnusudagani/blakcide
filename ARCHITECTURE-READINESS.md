# Architecture readiness — activation guide

Every platform gap is now a **feature waiting for a provider**. The seams are
built and ship *dark*; each lights up by setting a key (and sometimes a flag).

Live status is always visible in-app: **`/beta/admin` → "Platform readiness"**
(or `GET /api/symp/v1/admin/capabilities` as admin). The registry that powers
it is `symp-core/lib/capabilities.mjs`. This doc adds the *how-to-activate* that
the status panel doesn't.

> Set Netlify env vars in the Netlify UI (PUBLIC_* require a rebuild to take
> effect). Set Supabase Edge secrets with `supabase secrets set` or the dashboard.

---

## Observability

### Product analytics  →  `analytics`
- **Activate (zero-dependency):** set `PUBLIC_ANALYTICS=1` (Netlify) + rebuild.
  Events start landing in `public.analytics_events` (query in Supabase).
- **Also forward to a provider (optional):** `PUBLIC_POSTHOG_KEY` (+ `PUBLIC_POSTHOG_HOST`)
  or `PUBLIC_PLAUSIBLE_DOMAIN`.
- **Server-side events:** set `ANALYTICS_SERVER=1` so `trackServer()` writes too.
- Code: `src/lib/analytics.ts` (client) · `symp-core/lib/analytics.mjs` (server).

### Error monitoring  →  `errors`
- Client error/rejection capture already lands in `analytics_events` once
  analytics is on. For a dedicated tool, wire `PUBLIC_SENTRY_DSN` (loader is a
  documented extension point in `analytics.ts`).

---

## Billing (entitlements are ready; pick a provider to charge)

The gate is live and provider-agnostic: `has_entitlement(feature)` /
`entitlement_quota(feature)` / `current_plan()` resolve from `billing_plans` +
`user_subscriptions`. Everyone is `free`; a paid plan (`plus`) exists but ships
`is_active=false`.

**To turn on paid billing:**
1. Decide the provider (**Razorpay** recommended for India / UPI; Stripe global; IAP/Play for mobile).
2. Set provider keys: `STRIPE_SECRET_KEY` *or* `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`.
3. Build the checkout + webhook (the webhook just upserts `user_subscriptions` with the plan + status).
4. Set `billing_plans.is_active=true` for the tiers you sell and fill in pricing (unset on purpose — undecided).
5. Gate features by calling `hasEntitlement(...)` where you want them (e.g. persona voice, Minit priority).
- Code: `src/lib/entitlements.ts` · `symp-core/lib/entitlements.mjs`.

---

## Notifications

A unified `notify({ userId, kind, title, body, channels, email })` writes the
in-app row and fans out to push + email — use it for new notifications.
Code: `symp-core/lib/notify.mjs`.

### Web push  →  `push.web`
- Already fully built. Set the VAPID keypair: `VAPID_SUBJECT` + the private key.
- **Footgun:** two senders read the SAME keypair under DIFFERENT names —
  the edge `push-send` fn wants `VAPID_PRIVATE_KEY`, the Node crons want
  `VAPID_PRIVATE_PKCS8`. Set **both** (same key, two encodings) until unified.

### Transactional email  →  `email`  *(was missing — now a seam)*
- Set `RESEND_API_KEY` *or* `POSTMARK_TOKEN` (+ optional `EMAIL_FROM`).
- Then pass `channels: ['in_app','email']` + an `email:{to,subject,html}` to `notify()`.
- Code: `symp-core/lib/email.mjs`.

### Native push  →  `push.native` · WhatsApp · SMS
- Native APNs/FCM: comes with the mobile wrap. WhatsApp (`WHATSAPP_TOKEN` +
  `WHATSAPP_PHONE_NUMBER_ID`) and SMS (`TWILIO_*`) seams are registered but
  delivery handlers aren't built yet.

---

## Trust & safety

### Image moderation  →  `moderation.image`
- Real verdicts: set `OPENAI_API_KEY` (free omni-moderation) or `GEMINI_API_KEY` + `GEMINI_BASE_URL`.
- **Fail closed:** set `MODERATION_MODE=closed` (Supabase Edge) so images are
  BLOCKED when no verdict is available. Only flip this *after* a provider is set,
  or every image upload is rejected. Default `open` = today's behavior.

---

## Voice

- **TURN relay** (`voice.turn`): `TURN_URLS` or `METERED_API_KEY` (ice-servers fn).
  Without it, calls fall back to STUN-only and fail behind strict NAT.
- **LiveKit SFU** (`voice.livekit`): `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`.
- **Persona voice clone** (`voice.clone`): `VOICE_INFER_URL` + `VOICE_FT_API_URL` (Modal GPU).

---

## Intelligence (LLM)

- **Primary** (`llm.primary`): `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`.
- **Paid OSS tier** (`llm.paid`) — lifts the #1 scale ceiling: any of
  `OPENROUTER_API_KEY` / `TOGETHER_API_KEY` / `FIREWORKS_API_KEY` / `DEEPINFRA_API_KEY`.
- **Free floor** (`llm.floor`): `GROQ_API_KEY`. The router auto-includes whatever is set.

---

## Integrations

Registry exists (`symp_integrations` + `symp_oauth_tokens` vault). Tokens refresh
on-demand at use.
- **Gmail** (`integrations.gmail`): `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` (+ a Google test user during review).
- **Spotify** (`integrations.spotify`): `SPOTIFY_OAUTH_CLIENT_ID` + `SPOTIFY_OAUTH_CLIENT_SECRET`.
- **ONDC** (`integrations.ondc`): `ONDC_SUBSCRIBER_ID` (+ sandbox creds for real cab booking).

---

## Community (Nexus)

- **Server-proxy** (`nexus.proxy`): `PUBLIC_NEXUS_PROXY=1` (already set on prod).
  Remaining one-way step: run the `_revoke_base` migration once you've confirmed
  Nexus renders in-app — closes direct table access.
- **Blak peer** (`nexus.blak`): set the Edge secret `NEXUS_BLAK_CRON_SECRET`.

---

## Decisions still open (not blocking)

- **Auth + 18 age enforcement** — client-only on the static build today
  (fail-open). Options: enforce via Supabase RLS everywhere (no hosting change)
  or add Astro SSR/middleware (strongest, changes the runtime). Pick one.
- **Payments provider** — Razorpay (India-first) vs Stripe vs store IAP.
- **Persona-to-Persona** — the "future of social" feature needs a product spec
  (turn model, initiation, visibility) before a schema is worth laying.
- **Mobile (Capacitor)** — deferred. Bridge shim builds when you're ready.
