# Minit → app-grade, fully-built

**Goal:** take Minit from "live beta that works" to a **fully-built, app-grade feature of Blaksyd** — so the eventual mobile app is a *port*, not a rebuild. App-grade means: complete against the canonical spec ([What is BLAKSYD?/blaksyd_minit.md](../T2M/What%20is%20BLAKSYD%3F/blaksyd_minit.md)), reliable on real mobile networks, safe on both sides, and built API/RPC-first so a native client reuses the same backend.

Source of truth for scope: `blaksyd_minit.md`. Status legend: ✅ built & working · ⚠️ partial · ❌ missing.

---

## ✅ Shipped status — 2026-06-19 (Phases 0–4 complete)

Live on blaksyd.com (Supabase T2MWEB), PRs #25–#30, 7 migrations:
- **0 Matching** · **1 Security** · **2a In-app notifications + priority callbacks** · **3 all four connect modes** (Instant · Smart Match · Listener Discovery · Reconnect + history-consent) · **4 two-sided safety** (moderation + `/beta/admin` console · seeker crisis surface · listener wellbeing/debrief · boundary nudges).

**Remaining — each needs your infra/decisions (can't be completed solo) or is optional polish:**
- **Crisis helplines** — fill `CRISIS_HELPLINES` in `src/pages/beta/minit.astro` with verified numbers.
- **2b/2c/2d push + WhatsApp** — needs VAPID keys + a `notify-send` edge-function deploy + DB webhook + WhatsApp opt-in.
- **5 reliability** — TURN servers (provider credentials — mobile calls fail on STUN-only) + PWA install + reconnection (authorable).
- **6 monetization** — payment provider + the unresolved pricing decision.
- **7 polish + admin metrics view** (authorable).

The detailed gap analysis + phase plan below is the original map (historical).

---

## 1. Where Minit is today

**Working:** Instant matching (now queue-aware, Phase 0), realtime text chat (typing / delivered / seen), WebRTC voice, anonymous-by-default, basic Reconnect, read-only past-conversation history, post-session feeling+rating review, listener console (availability + presence heartbeat, live incoming queue, accept/decline, private notes, flag-session, stats), free-credit cap (10/day · 30/week), reaper crons, append-only analytics (`minit_events`), "set a time" scheduled pool.

**Live reality:** 1 listener (hand-created in the DB), 0 admin surface, 116 completed sessions historically.

---

## 2. Gap analysis (360°)

### A. Connect modes — the headline feature gap
- **L1 Instant Match** — ✅ (Phase 0: queue-aware, one-active-per-listener, "next in line", honest reconnect)
- **L2 Smart Match** — ❌ no mood / topic / language / preference intake; `listeners.languages` exists but is unused in matching
- **L3 Reconnect** — ⚠️ works, but no *consented history sharing* (vision: opt to let the listener see past history for continuity)
- **L4 Listener Discovery (premium)** — ❌ no listener directory / browsable profiles (bio, languages, style, rating, availability)

### B. Blak co-pilot brief — the differentiator
- ⚠️ `symp_listener_briefs` table exists and the listener UI renders it, but **nothing generates a brief**. "Context, not content" is not live end-to-end.

### C. Two-sided safety & moderation
- **Users:** anonymous ✅ · crisis resources one-tap ❌ (no Minit-side crisis surface for the seeker) · emergency escalation ⚠️ · T&S review ❌
- **Listeners:** instant exit ✅ · report/flag ⚠️ (flag writes a column, but no triage) · boundary protections ❌ · burnout controls (session limits / breaks) ❌ · supervisor escalation ❌ · debrief tools ❌
- **Moderation:** ❌ no admin surface; no user warnings / suspension / ban ("not the user is always right" is unenforceable today)

### D. Security & integrity (from the live RLS/advisor audit)
- ❌ **Anyone can self-enroll as a listener** (client INSERT policy on `listeners`)
- ❌ **Whole `listeners` table is world-readable** incl. `user_id`
- ❌ **Seekers can edit their own session timestamps** (`cs_update_party` unconstrained) → game the credit cap
- ⚠️ `session_seeker_name` is anon-callable — confirm it authorizes the caller + respects `is_anonymous`

### E. Reliability & call quality (mobile-critical)
- ❌ **WebRTC uses STUN only** — calls fail behind symmetric NAT / many mobile networks. Needs **TURN**.
- ❌ no **seeker presence** → a listener can be stuck "in session" with a ghost seeker
- ❌ no **reconnect/resync** after a network drop (mobile networks drop constantly)
- ⚠️ backgrounding: presence/heartbeat behavior when the tab/app is backgrounded

### F. Notifications ("everywhere" — chosen)
- ❌ no priority callback list · ❌ in-app banner · ❌ web push · ❌ WhatsApp
- ❌ **listener** push when a request arrives while their app is closed (today: in-tab beep + title flash only) — essential for 24/7 with thin supply

### G. Monetization
- ❌ session-based pricing / free-trial / subscription / pay-per-session; `chat_price_per_min` / `call_price_per_min` columns exist but unused; no listener payout accounting

### H. Design / app-grade UX
- ⚠️ consoles are well-designed (luminous, reduced-motion aware) but need: consistent skeleton/empty/error states everywhere, richer in-call UI, an accessibility pass, gesture/haptic-ready interactions

### I. Mobile-readiness (cross-cutting)
- API/RPC-first (matching is now RPC ✅ — extend to all session lifecycle) · PWA (installable + service worker) as the bridge to native · responsive verified on small screens · push that maps cleanly to native push later

### J. Observability / ops
- ❌ no admin dashboard (who's online, queue depth, wait times, session/listener metrics) — `minit_events` is logged but unused

---

## 3. Proposed phased roadmap

> Each phase is independently shippable and ordered so earlier phases unblock later ones. Mobile-readiness is a cross-cutting requirement in every phase, not a separate one.

- **Phase 0 — Matching foundation** ✅ *(done, on this branch)* — queue-aware Instant Match, capacity as a DB guarantee, honest reconnect, call-ready handshake, offline-listener reaper.

- **Phase 1 — Security & listener provisioning** ✅ *(built on branch — ships with Phase 0)* — killed self-enroll; own-row `listeners` SELECT + `listeners_public` safe view (no `user_id`); `connect_sessions` integrity trigger (server-owned `activated_at`/`ended_at`, gated accept) stops credit-gaming; `admin_provision_listener(email,…)` RPC. *Unblocks safely adding the 2–3 listeners.*

- **Phase 2 — Notifications "everywhere"** — **2a ✅ built** (`notifications` inbox + `minit_callbacks` + freed-listener trigger + app-wide in-app banner). **2b web push / 2c WhatsApp / 2d listener push deferred** — need infra you control (VAPID secrets + edge deploy, WhatsApp opt-in). *Makes 24/7 real with thin supply.*

- **Phase 3 — Connect modes** — **3a Smart Match ✅ built** (intake → scored match on language/topic/gender, intake stored + shown to listener; richer listener profiles). **3b Listener Discovery** (directory + profiles, premium-gated) and **3c Reconnect history-consent** pending. *The headline feature depth.*

- **Phase 4 — Two-sided safety & moderation** — admin/T&S console (flagged-session triage, user/listener management, suspend/ban); seeker crisis surface + escalation; listener wellbeing (session limits/breaks, debrief, supervisor escalation); boundary protections.

- **Phase 5 — Reliability & call quality for mobile** — TURN servers; seeker presence; drop/reconnect+resync; backgrounding; PWA shell (installable, offline).

- **Phase 6 — Monetization** — free trial / subscription / pay-per-session; listener payout accounting.

- **Phase 7 — Design polish & observability** — app-grade UX pass (states, in-call UI, a11y), admin metrics dashboard.

---

## 4. Mobile-readiness principles (apply in every phase)
1. **RPC-first**: every action a native client needs is a Supabase RPC, not browser-only logic.
2. **Push that ports**: web push now, structured so native FCM/APNs drops in later.
3. **Network-resilient**: assume drops; resync state on resume; TURN for voice.
4. **Responsive + gesture-ready**: layouts and interactions that translate to native.
