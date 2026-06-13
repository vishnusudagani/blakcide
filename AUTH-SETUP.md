# Blaksyd — Early-Access Auth Setup (step by step)

This wires up the new sign-in modal: **passwordless email + Google + WhatsApp OTP**, all on Supabase Auth, with WhatsApp delivered by Blak's own Meta Cloud API.

**Do the steps in THIS order** — some give you values the next step needs. Keep a scratchpad open and copy values into it as you go. You'll paste them all into env vars at the end (Step 6).

**Scratchpad — values you'll collect:**
```
PUBLIC_SUPABASE_URL        = ____   (Step 1)
PUBLIC_SUPABASE_ANON_KEY   = ____   (Step 1)
Google Client ID           = ____   (Step 2 — pasted into Supabase, not an env var)
Google Client Secret       = ____   (Step 2 — pasted into Supabase, not an env var)
WHATSAPP_PHONE_NUMBER_ID   = ____   (Step 4)
WHATSAPP_TOKEN             = ____   (Step 4)
WHATSAPP_OTP_TEMPLATE      = ____   (Step 4)
WHATSAPP_OTP_LANG          = ____   (Step 4, e.g. en_US)
WHATSAPP_OTP_BUTTON        = ____   (Step 4, 1 or 0)
SEND_SMS_HOOK_SECRET       = ____   (Step 5)
```

Nothing breaks while you do this — until the env vars exist, the modal quietly falls back to your existing waitlist (email still gets captured; Google/WhatsApp show "being set up").

---

## STEP 1 — Get your Supabase keys  ⏱ 2 min

These are the two **public** keys the browser uses. (Safe to expose — Row-Level Security protects your data. This is NOT the service-role key.)

1. Go to **https://supabase.com/dashboard** → open your Blaksyd project (the same one the waitlist already uses).
2. Left sidebar → **Project Settings** (gear icon) → **API**.
3. Copy two things into your scratchpad:
   - **Project URL** → `PUBLIC_SUPABASE_URL` (looks like `https://abcd1234.supabase.co`)
   - **Project API keys → `anon` `public`** → `PUBLIC_SUPABASE_ANON_KEY` (a long `eyJ…` string)
4. Also note your **project ref** = the `abcd1234` part of the URL — you'll need the callback URL `https://abcd1234.supabase.co/auth/v1/callback` in Step 2.

✅ Done when: you have both values + the callback URL written down.

---

## STEP 2 — Create the Google OAuth client  ⏱ 10 min

This is what powers "Continue with Google."

1. Go to **https://console.cloud.google.com** → pick (or create) a project, e.g. "Blaksyd".
2. Sidebar → **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - App name: **Blaksyd**, user support email: **ceo@blaksyd.com**, developer contact: same.
   - Scopes: click **Add or Remove Scopes** → tick `.../auth/userinfo.email` and `.../auth/userinfo.profile` → Update → Save.
   - (While in "Testing" mode, add your own Google email under **Test users** so you can try it before Google verifies the app.)
3. Sidebar → **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - Application type: **Web application**. Name: "Blaksyd Web".
   - Under **Authorized redirect URIs → + Add URI**, paste your Supabase callback from Step 1:
     `https://<your-ref>.supabase.co/auth/v1/callback`
   - Click **Create**.
4. A popup shows **Client ID** and **Client secret** — copy BOTH into your scratchpad.

✅ Done when: you have the Google Client ID + Secret.

---

## STEP 3 — Configure Supabase Auth (Google + Phone + URLs)  ⏱ 5 min

Back in the Supabase dashboard (same project).

**3a. Enable Google**
1. Left sidebar → **Authentication → Providers** → find **Google** → toggle **Enabled**.
2. Paste your **Client ID** and **Client Secret** from Step 2 → **Save**.

**3b. Enable Phone** (needed for WhatsApp OTP)
1. Same **Providers** list → **Phone** → toggle **Enabled** → **Save**.
2. Ignore the Twilio / MessageBird fields — the Send-SMS Hook in Step 5 takes over delivery, so you don't need an SMS provider here.

**3c. Set your site URLs**
1. **Authentication → URL Configuration**.
2. **Site URL:** `https://blaksyd.com`
3. **Redirect URLs → Add URL** (add both):
   - `https://blaksyd.com/**`
   - `http://localhost:4321/**`
4. **Save.** (This is what lets the Google / email-link redirect land back on your site.)

✅ Done when: Google + Phone are green/enabled and your URLs are saved.

---

## STEP 4 — Meta WhatsApp: token, number, and an OTP template  ⏱ 15 min + approval wait

You already run Blak's number on the Meta Cloud API, so you have the app — you mainly need an **authentication template** approved.

1. Go to **https://developers.facebook.com** → your Blaksyd/Blak app → left menu **WhatsApp → API Setup**.
   - Copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
   - For the token: the temporary token on this page works for testing. For production, create a **permanent** one: **Business Settings → Users → System Users →** add/select a system user → **Generate token** → app = your app, scopes = `whatsapp_business_messaging` + `whatsapp_business_management` → copy it → `WHATSAPP_TOKEN`.
2. Create the OTP template: **WhatsApp → Message Templates → Create Template**:
   - Category: **Authentication**.
   - Name: e.g. `blaksyd_otp` → `WHATSAPP_OTP_TEMPLATE`.
   - Language: e.g. **English (US)** → `WHATSAPP_OTP_LANG` = `en_US`.
   - Use the built-in authentication layout: it has a body with the **{{1}}** code and (recommended) a **"Copy code"** button.
     - If you keep the copy-code button → `WHATSAPP_OTP_BUTTON` = `1`.
     - If you remove it (code in body only) → `WHATSAPP_OTP_BUTTON` = `0`.
   - **Submit** → wait for Meta approval (minutes to a few hours). You can't send through it until it's **Approved**.

✅ Done when: phone-number-id + token saved, and the template shows **Approved**.

---

## STEP 5 — Turn on the Supabase "Send SMS" hook  ⏱ 3 min

This is the bridge: Supabase makes + checks the code; your function (already built, deployed at `/api/send-whatsapp-otp`) delivers it over WhatsApp.

1. Supabase → **Authentication → Hooks** (may be under "Auth Hooks" / Beta).
2. Find **"Send SMS hook"** → **Enable** → type **HTTPS**.
3. **URL:** `https://blaksyd.com/api/send-whatsapp-otp`
4. Click to **generate a secret** → it looks like `v1,whsec_…` → copy the WHOLE thing into `SEND_SMS_HOOK_SECRET`.
5. **Save.**

✅ Done when: the hook is enabled, pointing at your URL, and you've copied the secret.

---

## STEP 6 — Put all the values into env vars  ⏱ 5 min

**6a. Netlify (production):**
1. **https://app.netlify.com** → your Blaksyd site → **Site configuration → Environment variables**.
2. Add each (Key + Value), scope = **All / Production**:
   ```
   PUBLIC_SUPABASE_URL
   PUBLIC_SUPABASE_ANON_KEY
   SEND_SMS_HOOK_SECRET
   WHATSAPP_TOKEN
   WHATSAPP_PHONE_NUMBER_ID
   WHATSAPP_OTP_TEMPLATE
   WHATSAPP_OTP_LANG          (e.g. en_US)
   WHATSAPP_OTP_BUTTON        (1 or 0)
   ```
3. **Trigger a redeploy** (Deploys → Trigger deploy → Deploy site) so the new `PUBLIC_*` vars get baked into the site.

**6b. Local (`.env` in the `site/` folder)** — only needed to test on localhost:
```
PUBLIC_SUPABASE_URL=...
PUBLIC_SUPABASE_ANON_KEY=...
```
(The WhatsApp/hook vars only matter on the deployed function, so locally you can test Google + email; WhatsApp end-to-end is easiest to test on the live site.)

⚠️ Don't commit `.env` — it's already git-ignored.

✅ Done when: all 8 vars are in Netlify and you've redeployed.

---

## STEP 7 — Test  ⏱ 5 min

1. Open **https://blaksyd.com**, click **Get early access**.
2. **Email:** type your email → "Email me a sign-in link" → check inbox → click the link → it should land back on the site signed in.
3. **Google:** click Continue with Google → pick your account → redirects back signed in.
4. **WhatsApp:** click Continue with WhatsApp → enter your number **with country code** (`+91…`) → you get a WhatsApp message with the code → enter it → "You're in."
5. Confirm in Supabase → **Authentication → Users** that the new users appear.

### If something fails
- **Google "redirect_uri_mismatch":** the URI in Google (Step 2) must be EXACTLY the Supabase callback (Step 1), including `https://` and `/auth/v1/callback`.
- **WhatsApp code never arrives:** template not **Approved** yet, or `WHATSAPP_OTP_BUTTON` doesn't match your template's actual layout, or token expired. Check Netlify → Functions → `send-whatsapp-otp` logs.
- **"invalid signature" in the function log:** `SEND_SMS_HOOK_SECRET` must be the FULL `v1,whsec_…` value from Step 5.
- **Email link "otp_expired" / wrong site:** make sure your site URL + redirect URLs (Step 3c) include the exact domain you're testing on.

---

When all three methods work, the only follow-up is reconciling early-access `auth.users` with your existing `signups` waitlist table (a small SQL/policy task) — ping me and I'll write it.
