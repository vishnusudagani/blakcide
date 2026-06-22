# Nexus — Gaps → Build Roadmap

**Owner:** Vishnu · **Created:** 2026-06-21 · **Status legend:** ⬜ not started · 🟦 in progress · ✅ done · 🚫 won't do (by decision)

This doc turns the 50 known gaps in Beta Nexus into a sequenced build plan. It records the 28 product/architecture decisions made on 2026-06-21 and maps every gap to a phase. Rollout is **feature-flagged, cluster by cluster** (each phase ships behind a flag, validates in beta, then expands).

---

## 0. Context — the two-stack reality

Beta Nexus today has **two parallel backends**, and only one is wired in:

- ✅ **Live path** — the frontend (`src/pages/beta/_nexus-app.ts`) talks **directly to Supabase** (RLS-gated). Blak participates via the `nexus-blak` edge function (Gemini). Learning via `nexus-learn` (nightly).
- ⚠️ **Dormant path** — a full Netlify API (`netlify/functions/symp-v1-nexus.mjs`) + libs (`symp-core/lib/nexus/{resonance,ai-participant,escalation,trend-analyzer}.mjs`). **Nothing calls it.** It's the older, more ambitious "Echo" design (pgvector resonance, gpt-4o-mini AI participant, crisis classifier, trend-spawned pop-up tribes).

**Decision:** rebuild those capabilities **natively on Supabase edge functions** (consistent with the live arch) and **retire the dormant Netlify stack**. See Phase 5.

---

## 1. Decision record (2026-06-21)

| # | Decision | Choice |
|---|----------|--------|
| Strategy | Build order | **Severity order** — blockers → recognition → features → scale |
| Arch | Dormant stack | **Rebuild native on Supabase**; retire Netlify `symp-v1-nexus` + libs |
| Safety | Moderation engine | **OpenAI omni-moderation (text) + a vision model (image NSFW)**; CSAM hash-matching added separately |
| Privacy | Cross-tribe de-anon (#12/#13) | **Server-proxy all IDs** — raw `user_id` never reaches the client; server mints opaque per-tribe handles + ids |
| Recognition | Resonance | **Full pgvector match** (you↔content/author %, ranks the feed) |
| Recognition | Streaks | **Gentle contribution streak + per-tribe streaks**; soft decay, no guilt (anti-FOMO) |
| Recognition | Badges | **All 4 families**: Milestones, Contribution-quality, Presence, Guardian/community-health (concrete set TBD) |
| Feed | Algorithm | **Resonance-ranked personalized** |
| Rooms | History | **Fully ephemeral** (no persistence — keep the moment) |
| Rooms | Room↔tribe link | **Add `community_id` FK** to `nexus_rooms` |
| Rooms | Host controls | **Close room + capacity limit** |
| Rooms | Presence integrity | **Server-authoritative** (ignore client-sent counts; anti-spoof) |
| Blak | Old "Echo" path | **Migrate useful bits (TL;DR, zero-engagement nudges) into `nexus-blak`, then remove** the Netlify path |
| Blak | Role in tribe/room | **Full conversational participant** — frequent, peer-like, **always replies on @mention** (loosen the 6/day + 5h-cooldown throttle) |
| Blak | Summon | **@Blak in tribes + rooms** |
| Blak | Output safety | **Trust the model** (no extra classifier on Blak's own posts) |
| Notifs | Reach | **In-app + push + email** |
| Notifs | Events | reply · resonate/impact · new DM · a tribe you're in goes live |
| Social | Discussions live-update | **Realtime posts + comments** (like rooms/DMs) |
| Social | Search | **Postgres full-text** (posts, tribes, people) |
| Social | New post types | **Long-form / rich text + polls** (no link-preview/reels yet) |
| Social | Tribe visibility | **Public + private + anonymous** (all three) |
| Compliance | Data rights | **Self-serve export + delete** in `/beta/account` |
| Compliance | Age gate | **DOB at signup + 18+ enforcement + consent record** |
| Safety | DM consent | **Message requests** — a stranger's first message lands in a requests inbox |
| Safety | Crisis response | **Soft-hide + private Minit hand-off + helpline** |
| Rollout | Strategy | **Feature-flagged, cluster by cluster** |
| Tracking | Method | **This roadmap doc + tracked tasks** |

**Defaults chosen by Claude (override anytime):**
- **Pagination (#47):** keyset/cursor pagination + counts via aggregate RPC.
- **Analytics (#50):** self-host in Supabase (events table + admin dashboard); revisit PostHog/Amplitude if needed.

---

## 2. Phased roadmap (all 50 mapped)

### Phase 0 — Foundation & server-proxy  🟦
*Execution chosen: PostgreSQL `security_invoker` views + `SECURITY DEFINER` RPCs (PostgREST **is** the proxy) instead of a bespoke always-on edge function — lower-risk + idiomatic; edge functions are reserved for the compute-heavy phases (resonance, moderation). Migrations: `20260621_nexus_server_proxy.sql` + `_handle_fix.sql` (applied to T2MWEB).*
- ✅ **F1 (data).** Tokenised identity: `token` on `nexus_anonymous_handles`; best-effort mint triggers + backfill; identity-safe views (`nexus_posts_view`/`nexus_comments_view`/`nexus_dm_messages_view` — **no raw uid**); write RPCs (`nexus_create_post`/`_comment`, `nexus_set_resonance`, `nexus_send_dm`, `nexus_dm_thread`/`_inbox`); public-pseudonym resolver `nexus_handle_public`. Verified over REST: anon read carries token+handle, asking for `author_user_id` errors, writes are 403, legacy tables still 200. → closes **#12/#13/#14** at the data layer.
- ✅ **F1 (client).** `_nexus-data.ts` normalises legacy + proxy to one shape; `_nexus-app.ts` rewired (feed, posts, comments, resonance, DMs). `astro build` passes.
- ✅ **F2.** `PUBLIC_NEXUS_PROXY` flag (`'1'` = proxy; default off → live beta untouched).
- 🟦 **F3.** Server-owned counts: resonance RPC returns the authoritative count; full denorm integrity deferred to Phase 7 (**#48**).
- ⬜ **Cutover (pending):** authed end-to-end test (the beta auth gate blocks headless verification) → flip `PUBLIC_NEXUS_PROXY=1` in prod → run `20260621_nexus_proxy_revoke_base.sql` (written, **not applied** — the final leak close). Until then the flag stays off and prod runs the legacy path.

### Phase 1 — 🔴 Safety, privacy & compliance (launch blockers)  ✅ built (all 12 items; activation gates noted)
- 🟦 **#1** Report/flag. *(backend + verified; **report UI live on posts, comments + DMs** — `⋯` → 8-reason sheet via `nexus_report`. Remaining: the moderator review queue, #7.)*
- 🟦 **#2** Block/mute users. *(backend + verified; **block UI live on posts, comments + DMs** — blocked users' content vanishes via the view filter and they can't DM you. Remaining: an unblock-management list.)*
- 🟦 **#3** Image moderation — `nexus-image-mod` edge fn (deployed) checks each upload (OpenAI free moderation → Gemini vision → **fail-open**); a blocked image is deleted + rejected. Gated behind the proxy flag. **Activates once a moderation key is set** (a free OpenAI key, or the Gemini proxy if it accepts image inputs) — fail-open until then. CSAM hash-matching (PhotoDNA, free for qualifying platforms) = documented `TODO(csam)` in the edge fn.
- 🟦 **#4** Crisis classification. *(Tier 1 SHIPPED + verified: deterministic lexical classifier (EN + romanized TE/HI) as a `BEFORE INSERT` trigger on posts+comments — runs in BOTH modes, soft-hides criticals on the way in. `20260622_nexus_crisis.sql`. Tier 2 = LLM second-opinion edge fn for elevated/ambiguous, pending.)*
- 🟦 **#5** Crisis response. *(SHIPPED: critical → soft-hidden + a private author-only support card — warm copy, "Talk to a Listener" → Minit, KIRAN/Tele-MANAS helplines. `nexus_crisis_events` owner-RLS; both modes.)*
- 🟦 **#11** Soft-hide lifecycle — author gets a private notice when a mod/admin/ban removes their content (`AFTER UPDATE` trigger → `nexus_content_notices`, shown on next load; crisis excluded, it has its own card). `20260622_nexus_content_notices.sql`, verified. Review path = the admin queue (#7); an author-contests-*appeal* UI is a follow-up.
- ✅ **#6** Tribe-owner moderation — a moderator can **remove a post/comment** *and* **ban a member** via the `⋯` sheet. Bans remove membership, hide their posts, and BEFORE INSERT triggers block re-posting/re-joining (both modes). `nexus_mod_remove_post`/`_comment` + `nexus_mod_ban` + `nexus_tribe_bans`. `20260622_nexus_tribe_moderation.sql` + `_tribe_bans.sql`, verified.
- ✅ **#7** Nexus moderation queue — open reports surface in `/beta/admin` (`is_admin`-gated) with **Hide content / Dismiss** actions. `nexus_admin_reports` / `nexus_admin_resolve`. `20260622_nexus_admin_queue.sql`, verified.
- ✅ **#8** Posting rate limits / anti-spam — `BEFORE INSERT` triggers on posts/comments/DMs (8 · 30 · 40 per 5 min), both modes, Blak-exempt. `20260622_nexus_rate_limit.sql`, verified.
- 🟦 **#9** Age-gate — one-time DOB confirmation in the beta shell (`AppLayout`); under-18 → signed out; DOB + `age_confirmed_at` stored on the auth user. Additive + **fail-open** (a bug can't lock anyone out). **Needs a logged-in verification** before relying on enforcement.
- ✅ **#10** DM message-requests — a stranger's first DM → **Requests** (not your inbox); accept (or just reply) to open, decline to block further messages. `nexus_dm_threads` state machine + accept/decline RPCs + inbox split UI. `20260622_nexus_dm_requests.sql`, verified (backfill = existing pairs, all accepted).
- 🟦 **#15** Self-serve data export + delete — **backend shipped + verified** (`nexus_export_my_data` / `nexus_delete_my_data`, owner-scoped). The account-page UI was **dropped at merge** (a concurrent session already shipped an account-wide "Download my data" in `/beta/account`); adding a Nexus **delete** button on top of theirs is a clean follow-up. `20260622_nexus_data_rights.sql`.
- 🚫 **#46** Blak output classification — *by decision, trust the model.*
- *(#12 / #13 / #14 delivered in Phase 0.)*

### Phase 2 — Recognition layer  ✅ built (resonance = heuristic; pgvector is the documented upgrade)
- 🟦 **#20** Resonance — **heuristic v1** (shared-tribe + impact + recency → 0–100%) via `nexus_feed`. Full pgvector embeddings = `TODO(resonance-pgvector)` (free Gemini embeddings + `nexus_vault_embeddings`).
- ✅ **#17** Resonance-ranked **"For you" feed** — `nexus_feed` RPC + a home section; token-safe, honours block + soft-hide. `20260622_nexus_feed.sql`.
- ✅ **#18** Streaks — gentle current/longest contribution streak chip (no guilt, no decay-punishment). `nexus_my_streak`.
- ✅ **#19** Badges — 8 earned badges across Milestone / Presence / Contribution families, shown on the home. `nexus_my_badges`. (Guardian family = follow-up.) `20260622_nexus_recognition.sql`.

### Phase 3 — Missing social features  🟦 partial (`20260622_nexus_social.sql`)
- ✅ **#25 / #26** Delete your own posts/comments (UI live, owner-gated RPCs); edit RPCs built — inline-edit UI is a follow-up.
- ✅ **#31** Search — `nexus_search` (token-safe ILIKE) wired into the home search box (matches tribes **and** posts). FTS relevance ranking = upgrade.
- ✅ **#30** Realtime discussions — tribe posts live-update via a Supabase realtime subscription (refetch on change); `nexus_posts`/`nexus_comments` added to the publication.
- ✅ **#24** Long-form composer — discussion body is now a multi-line `<textarea>`; posts render with `white-space: pre-wrap`.
- ✅ **#27** Threaded replies — `nexus_comments_threaded` (token-safe, exposes `parent_id`) + nested render + per-comment "reply" → parented `nexus_create_comment`.
- ✅ **#28** Tribe types — public / private / anonymous selector on create; non-public tribes excluded from discovery + member-gated by RLS. `20260622_nexus_tribe_types.sql`.
- ✅ **#29** Notifications (in-app) — best-effort triggers drop reply / resonance / DM events into the existing `notifications` inbox (AppLayout surfaces them). `20260622_nexus_notifications.sql`. Push + email need infra (FCM/APNs, email) — documented.
- ⬜ **#21** Polls — DEFERRED (design fork: add a `poll` column → recreate the views/RPCs that use the view rowtype, **or** a separate poll surface; lower priority than the shipped core).

### Phase 4 — Live Rooms  🟦 (structure done; presence/voice constrained)
- ✅ **#39** Rooms ↔ tribes — `nexus_rooms.community_id` FK; a tribe's "Start a room" tags + reuses by `community_id` (no more title-matching). `20260622_nexus_rooms.sql`.
- ✅ **#38** Host controls — host can **close** the room (`nexus_close_room`); `capacity` column added.
- 🟦 **#40** Server-authoritative presence — `nexus_room_heartbeat` is the integrity point, but Supabase Realtime presence is inherently client-reported; true server-authority needs a presence-tracking edge layer (infra). Documented.
- ⬜ **#41** Room scheduling / announce — follow-up (rooms are spontaneous by design; reminders need push).
- ⬜ **#42** Reconnect — Realtime auto-rejoins channels; an explicit resume is a follow-up.
- ✅ **#33** Shareable invite links — durable `?tribe=<id>` deep link + a 🔗 share button; RLS gates private/anon to members. (Rooms are ephemeral → no durable room link.)
- 🚫 **#37** Room message persistence — by decision, stay fully ephemeral.
- 🧱 **Voice rooms (#43 B/C)** — INFRA WALL: needs an SFU/TURN media server (not provisioned).

### Phase 5 — Blak in Nexus  🟦 (engine shipped; activation = `NEXUS_BLAK_CRON_SECRET`)
- 🟦 **#44** Retired the old "Echo" cron — `symp-cron-nexus` schedule disabled (no more double-posting vs the Gemini `nexus-blak`). Deleting the dead Netlify stack + porting TL;DR summaries into nexus-blak = follow-up.
- ✅ **#43** Blak more present — daily cap 6→15, tribe cooldown 5h→2h; **mentions bypass the cap**. `nexus-blak` v6 deployed.
- ✅ **#45** @Blak summon — `@blak` in a post/comment fires a trigger → `nexus-blak` `mention` mode replies (threaded under a comment). `20260622_nexus_blak_mention.sql` + engine `onMention`.
- 🧱 **Blak speaking in a voice room** — INFRA WALL: SFU/TURN + server audio mixing (not provisioned).
- *Activation:* answers only when `NEXUS_BLAK_CRON_SECRET` (Edge secret) + vault `nexus_blak_url`/`nexus_blak_cron_secret` are set; until then the triggers are harmless no-ops.

### Phase 6 — Growth, discovery & retention  🟦
- ✅ **#32** Tribe discovery — `nexus_trending_tribes` (public tribes by recent activity) + a "Discover" home section. `20260622_nexus_discovery.sql`. Native replacement for the dormant trend-spawner.
- ✅ **#36** Onboarding — one-time dismissible Nexus intro (anti-FOMO, localStorage-gated).
- ⬜ **#34** Re-engagement (email/push digests) — needs push/email infra.
- ⬜ **#35** Cold-start seeding — ops/content (Blak's quiet-tribe starters already help).

### Phase 7 — Engineering & scale  🟦
- ✅ **#47** Pagination/limits — `loadDiscussions` capped at 50, the global tribe-count read capped at 2000, feed/search already limited. (Keyset cursor for infinite-scroll = follow-up.)
- ✅ **#48** Count integrity — impact/comment counts are denormalised via DB triggers (server source of truth) + the resonance RPC returns the authoritative count.
- 🟦 **#49** Ghost rooms — handled by the existing 1-min `nexus_sweep_rooms` cron + `pagehide` beacon; full server-authoritative presence is the #40 caveat.
- ✅ **#50** Analytics — `nexus_admin_metrics` (is_admin) snapshot (tribes / posts / comments / rooms-live / active-7d / crisis-30d) in `/beta/admin`. `20260622_nexus_metrics.sql`.

---

## 3. Notes & open items
- **CSAM:** image hash-matching (#3) needs a provider decision (e.g. PhotoDNA / a hash list + NCMEC reporting path). Flag for legal before launch.
- **Concrete badge set (#19):** to be proposed during Phase 2.
- **Anonymous tribes (#28):** define exactly what's hidden (membership + author handles) vs a private tribe.
- **Concurrency:** the `blakcide` branch is shared across sessions — commit atomically (per project memory).
