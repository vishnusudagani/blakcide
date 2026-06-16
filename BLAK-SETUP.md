# Blak — setup & Phase 0 status

Blak is the AI-companion pillar. The engine (`symp-core/` + `netlify/functions/` +
`supabase/functions/`) is already built; Phase 0 makes the **real Blak live on the
web beta** and wires the model stack. This file is the operator checklist.

## What Phase 0 changed (in code)
- **Un-gated Blak** in the beta app — `AppLayout.astro` nav, `beta/blak.astro`,
  and `beta/index.astro` (Blak now shows **Live**, not "Soon"). Persona/Minit stay "soon".
- **Gemini added as the credit-funded quality primary** in both routers
  (`symp-core/lib/llm-providers.mjs` and `supabase/functions/_shared/llm.ts`),
  ahead of the Qwen hosts, with **Groq Llama 3.3 70B** kept as the free floor.
- **Minit co-pilot** (`netlify/functions/listener-copilot.mjs`) moved off OpenAI
  onto the open-source router.
- Added **`.env.example`** and **`scripts/blak-llm-bakeoff.mjs`**.

## What YOU need to set (manual)

### 1. LLM keys (Netlify → Site settings → Environment variables)
| Key | Where to get it | Notes |
|---|---|---|
| `GEMINI_BASE_URL` + `GEMINI_API_KEY` | the ADC proxy (§1a) | Org **disallows Google API keys**, so Blak reaches Gemini through the ADC Cloud Run proxy in `services/gemini-proxy` (no keys; draws the ₹28k credits). `GEMINI_BASE_URL` = proxy URL, `GEMINI_API_KEY` = proxy secret. |
| `GROQ_API_KEY` | console.groq.com | Free floor; already in use today. |
| `SARVAM_API_KEY` | sarvam.ai | For the Telugu/Hindi bake-off (chat + TTS later). |
| One Qwen host | DeepInfra / Together / OpenRouter | Optional OSS quality tier / fallback once credits lapse. |

Router priority: **Gemini → Qwen hosts → Groq**. Unset `GEMINI_API_KEY` and it
auto-falls back to the OSS floor — no redeploy logic needed.

### 1a. Gemini via the ADC Cloud Run proxy (org bans API keys)
Full guide: `services/gemini-proxy/README.md`. In short, from that folder:

```bash
PROJECT=YOUR_PROJECT; REGION=us-central1
gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com aiplatform.googleapis.com cloudbuild.googleapis.com
gcloud iam service-accounts create blak-vertex-proxy --display-name="Blak Vertex proxy"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:blak-vertex-proxy@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
SECRET=$(openssl rand -hex 24); echo "PROXY_SECRET=$SECRET"
gcloud run deploy blak-vertex-proxy --source . --region "$REGION" \
  --service-account "blak-vertex-proxy@$PROJECT.iam.gserviceaccount.com" \
  --set-env-vars "GCP_PROJECT=$PROJECT,GCP_REGION=$REGION,PROXY_SECRET=$SECRET" \
  --allow-unauthenticated
```

Then in Netlify set `GEMINI_BASE_URL=https://<run-url>/v1/chat/completions`,
`GEMINI_API_KEY=<that secret>`, `GEMINI_CHAT_MODEL=gemini-2.5-flash`.
(If your org blocks public Cloud Run / `allUsers`, see the README's security note — we adapt.)

### 2. Proactive cron secrets (Supabase → SQL editor)
The proactive engine fires from `pg_cron` (migration `20260612_blak_proactive_cron.sql`),
which reads two Vault secrets. Set them once:

```sql
select vault.create_secret('https://YOUR-PROJECT.functions.supabase.co/blak-proactive', 'blak_proactive_url');
select vault.create_secret('GENERATE_A_LONG_RANDOM_STRING', 'blak_cron_secret');
```

Set the **same** `blak_cron_secret` as an Edge Function secret so `blak-proactive`
can verify the cron caller:

```bash
supabase secrets set BLAK_CRON_SECRET=GENERATE_A_LONG_RANDOM_STRING
```

### 3. Deploy
`npm install && npm run build` then deploy to Netlify. Confirm `/beta/blak` streams a
reply when signed in.

## Run the model bake-off
Pick the Telugu/Hindi winner on credits before committing the primary:

```bash
GEMINI_API_KEY=... GROQ_API_KEY=... SARVAM_API_KEY=... \
  node scripts/blak-llm-bakeoff.mjs
```

It prints each model's reply + latency for EN / Hindi / Telugu (native + romanized)
companion prompts. Eyeball fluency + speed → set `GEMINI_CHAT_MODEL` / promote Sarvam.

## Cost control — don't burn the ₹28k
- **Wise model split:** chat → **Gemini 2.5 Flash** (quality + cheap); voice calls (Phase 2) → **Gemini 2.5 Flash-Lite** (fastest + cheapest). **Never Pro.** Set via `GEMINI_CHAT_MODEL` / `GEMINI_VOICE_MODEL`.
- **Hard ceiling (do this once):** in GCP set a **Billing budget alert** (Billing → Budgets & alerts, e.g. ₹8k / ₹15k) *and* a **Vertex AI quota cap** (IAM & Admin → Quotas → filter `aiplatform`) so spend physically cannot exceed it.
- **Free fallback built in:** if Gemini hits its quota / 429s / credits run out, the router auto-drops to **Groq (free, open-source)** — Blak never goes down, it just swaps brain. Unsetting `GEMINI_API_KEY` forces the OSS floor.
- **Per-reply caps:** the router already limits `max_tokens`, so no single call runs away.

## Still pending (later phases)
- **Phase 1** — semantic memory (pgvector + embeddings), web chat polish, onboarding.
- **Phase 2** — voice: Sarvam/Chirp TTS, STT, LiveKit calls; then retire `realtime-session.js`
  (the last OpenAI caller, on the legacy voice path).
- **Phase 3** — connected-apps / action layer (calendar → cab/food/tickets) with confirmation gating.
- Remaining OpenAI references to migrate: `summarize.js`, `vision.js`, `group-chat.mjs`,
  `symp-v1-transcribe.mjs`, `voice-clone.mjs` fallback.
