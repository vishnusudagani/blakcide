# Blaksyd — App Store & Play Store Compliance Punch-List

Scope: getting the **Capacitor app** (a native shell that loads the live `blaksyd.com/beta/`) through **Apple App Store** + **Google Play** review, plus **India DPDP**.

**Key principle:** most *feature* compliance lives in the **web app** and **inherits to the mobile app automatically** (the app loads the live site). So we do NOT rebuild it for mobile — we (a) verify the web app's coverage is store-adequate, and (b) do the few mobile-only + store-console items.

**Legend:** ✅ done · 🟡 partial / verify on web · 🔴 gap to build · 🔵 blocked — needs a dev account / store console

---

## Apple App Store

| Guideline | Requirement | Status | Action | Owner |
|---|---|---|---|---|
| **4.8** | Sign in with Apple (required *because* Google login is offered) | 🔵🔴 | Add native SiWA button + enable Apple provider in Supabase | mobile + **Apple acct** |
| **3.1.1** | In-App Purchase for digital goods | 🔵 | No paid features in-app yet; if Minit credits/subs go paid on iOS, must use IAP | mobile + **Apple acct** |
| **1.2** | UGC: in-app **report**, **block**, moderation queue, contact info | 🟡 | Exists across Nexus/Minit migrations — **verify** report+block on *every* Nexus post & user, and the `/beta/admin` queue is reachable | web |
| **1.4** | Health: "not a medical service" disclaimer + crisis safety + **helplines** | 🟡 | Crisis handling is in the chat/voice functions — **verify** real helpline numbers are shown to users (iCall 9152987821 / Vandrevala 1860-2662-345) and a clear non-medical acknowledgement at onboarding | web |
| **5.1.1** | Permission purpose strings + data minimization | ✅ | iOS mic/camera/photo usage strings added to Info.plist | mobile ✅ |
| **5.1.2** | App Privacy "nutrition label" (every data type) | 🔵 | Fill in App Store Connect — declare wellbeing/health, audio, identifiers, usage | **Apple console** |
| **2.1** | Completeness + reviewer demo account | 🔴 | Create a reviewer login + App Review notes | mobile + web |
| **—** | Age rating **17+** | 🔵 | Set in App Store Connect | **Apple console** |
| **4.2** | Minimum functionality (not a bare wrapper) | 🟡 | Mitigated by native push + mic + Sign in with Apple — finish those | mobile |

## Google Play

| Requirement | Status | Action | Owner |
|---|---|---|---|
| **Data Safety form** | 🔵 | Complete in Play Console (sensitive: wellbeing, audio) | **Play console** |
| Target API 35 | ✅ | Capacitor 8 targets current API | mobile ✅ |
| Sensitive permissions + rationale | 🔴 | Add `RECORD_AUDIO` (+ rationale) to AndroidManifest; request at point-of-need | mobile |
| AI-generated content disclosure | 🟡 | "AI" badge on Blak exists — extend to Persona / Nexus AI output | web |
| Play Billing for digital goods | 🔵 | Same as IAP | mobile + **Play acct** |
| **Account deletion URL** (Play requires a public one) | 🟡 | `account.astro` has in-app deletion — also expose a public deletion URL | web |

## India — DPDP

| Requirement | Status | Action | Owner |
|---|---|---|---|
| Purpose-specific, **logged** consent | 🟡 | Consent fields exist (voice/profile) — ensure a logged consent record per purpose | web |
| Sensitive/biometric (voice) consent **gate** | 🟡 | `voice_clips.consent_id` exists — verify an explicit pre-record consent modal | web |
| Data-principal rights: access / correct / **erase** / withdraw | 🟡 | Export + delete partly in account page — verify all four are real screens | web |
| Children's data — under-18 block | 🟡 | `minit_age_gate` exists — verify a **global 18+ gate at signup**, not just Minit | web |

---

## ✅ Mobile-owned & account-free — can do now
- ✅ iOS permission purpose strings (done)
- 🔴 Android manifest: `RECORD_AUDIO` + `com.blaksyd.app` deep-link intent-filter
- 🔴 App icon + splash screen
- 🔴 Reviewer demo account + App Review notes doc

## 🔵 Blocked until the dev accounts / consoles
Sign in with Apple · iOS push (APNs) · IAP / Play Billing · App Privacy nutrition label · Play Data Safety form · store age rating · TestFlight / store submission.

---
*Generated during mobile build-out. "web" items are the live-site team's domain (much in flight via the Nexus/Minit buildouts) and inherit to the app; verify, don't rebuild.*
