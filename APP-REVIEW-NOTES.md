# Blaksyd — App Review Notes (Apple & Google)

Paste into App Store Connect "App Review Information → Notes" and Play Console "Testing instructions". Fill the demo-account placeholders before submitting.

---

## What Blaksyd is
Blaksyd is a **Human + AI life platform**. It has four features in one app: **Blak** (an AI friend you chat with by text/voice), **Persona** (an AI version of the user + user-built characters), **Minit** (text/voice conversations with real, trained people, anonymous by default), and **Nexus** (a community: tribes, rooms, anonymous DMs). The app is a native shell over our live product; everything runs against our own Supabase backend.

## Demo account (please use this to review every feature)
- **Email:** `__REVIEWER_EMAIL__`
- **Password / sign-in:** `__REVIEWER_LOGIN__`
- Sign in from the first screen → "Email me a sign-in link" (or the reviewer Google account). The demo account is pre-seeded with Blak chats, a persona, and Nexus access.

## How to test each area
- **Blak:** open the app → type a message → Blak replies. Tap the mic/phone for voice.
- **Persona:** Persona tab → open a persona → chat or call it.
- **Minit:** Minit tab → "Connect" → a demo listener responds (text/voice).
- **Nexus:** Nexus tab → browse tribes, open a room, post. Every post/user has **Report** and **Block**.
- **Account/privacy:** Account → export data, delete account, manage consent.

## Things reviewers usually check
- **AI disclosure:** AI-generated replies (Blak, Persona) are labeled as AI in the UI.
- **Not a medical service:** Blaksyd is **not** a health/medical service and does not diagnose or treat. An acknowledgement is shown during onboarding. When a user expresses crisis/self-harm, the app surfaces helplines (India: iCall 9152987821, Vandrevala 1860-2662-345) and routes to a real human on Minit — the AI does not handle crisis content.
- **Voice is not recorded:** Minit calls use end-to-end-encrypted WebRTC and are not stored or recorded. Persona voice recordings require an explicit, separate biometric-consent screen and can be deleted by the user at any time.
- **UGC moderation (Nexus):** in-app Report + Block on all posts/users, a moderation queue, and removal of flagged content.
- **Permissions:** microphone is requested only when starting a voice conversation or recording; camera/photos only when adding media. Each has a clear purpose string.
- **Age:** 17+. Date-of-birth age-gate at signup blocks under-18.

## Contact
ceo@blaksyd.com · Operated by Blaksyd LLP (India)

## TODO before submit
- [ ] Create the reviewer demo account + seed it; fill the placeholders above
- [ ] Verify the onboarding disclaimer + age-gate are live on the deployed site
