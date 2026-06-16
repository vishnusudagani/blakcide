# Blak → Vertex AI (Gemini) proxy

A tiny OpenAI-compatible proxy so the deployed Blaksyd site can use **Gemini**
even though the org security policy **disallows Google API keys**.

- **Inbound:** speaks the OpenAI `POST /v1/chat/completions` shape that Blak's
  LLM router already calls. Gated by a shared secret.
- **Outbound:** authenticates to Vertex AI with **Application Default
  Credentials** (the Cloud Run service account — *no keys*) and forwards to the
  Vertex OpenAI-compatible Gemini endpoint. Streaming (SSE) passes through.
- **Billing:** runs in your credited GCP project, so Gemini + Cloud Run draw the
  ₹28k credits.

```
Blak router ──Bearer PROXY_SECRET──▶ Cloud Run proxy ──ADC token──▶ Vertex (Gemini)
```

## Deploy (one-time)

Prereqs: `gcloud` installed and logged in to the credited project.

```bash
cd services/gemini-proxy

PROJECT=YOUR_PROJECT          # the project that holds the ₹28k credits
REGION=us-central1            # or "global" for the global endpoint
gcloud config set project "$PROJECT"

# 1. Enable APIs
gcloud services enable run.googleapis.com aiplatform.googleapis.com cloudbuild.googleapis.com

# 2. Service account with Vertex access — NO key is created
gcloud iam service-accounts create blak-vertex-proxy --display-name="Blak Vertex proxy"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:blak-vertex-proxy@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# 3. Generate a shared secret (save it — you'll paste it into Netlify too)
SECRET=$(openssl rand -hex 24); echo "PROXY_SECRET=$SECRET"

# 4. Deploy from source (Cloud Build packages it)
gcloud run deploy blak-vertex-proxy \
  --source . \
  --region "$REGION" \
  --service-account "blak-vertex-proxy@$PROJECT.iam.gserviceaccount.com" \
  --set-env-vars "GCP_PROJECT=$PROJECT,GCP_REGION=$REGION,PROXY_SECRET=$SECRET" \
  --allow-unauthenticated
```

`gcloud run deploy` prints the **Service URL** (e.g. `https://blak-vertex-proxy-xxxx.run.app`).

## Point Blak at it (Netlify env vars)

```
GEMINI_BASE_URL   = https://blak-vertex-proxy-xxxx.run.app/v1/chat/completions
GEMINI_API_KEY    = <the PROXY_SECRET from step 3>     # NOT a Google key
GEMINI_CHAT_MODEL = gemini-2.5-flash                   # proxy adds the google/ prefix
```

Both Blak routers — web (`symp-core/lib/llm-providers.mjs`) and WhatsApp
(`supabase/functions/_shared/llm.ts`) — read these, so Gemini becomes the
primary and Groq stays the free floor.

## Smoke test

```bash
URL=https://blak-vertex-proxy-xxxx.run.app
curl -s -X POST "$URL/v1/chat/completions" \
  -H "authorization: Bearer $SECRET" -H "content-type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"namaste! ek chhoti si baat bolo"}]}'
```

## Config (Cloud Run env)

| Var | Required | Default | Notes |
|---|---|---|---|
| `GCP_PROJECT` | ✅ | — | The credited project. |
| `GCP_REGION` | — | `us-central1` | Use `global` for the global endpoint (higher availability). |
| `PROXY_SECRET` | ✅ (strongly) | — | Shared secret callers must present (Bearer or `x-proxy-secret`). |
| `PORT` | — | 8080 | Set by Cloud Run. |

Send the bare model id (`gemini-2.5-flash`); the proxy prefixes `google/` as
Vertex's OpenAI endpoint requires. If you get a 404 on the model, confirm it's
enabled in your project's Model Garden.

## Security note

The proxy is deployed `--allow-unauthenticated` and gated by `PROXY_SECRET`
(Netlify can't hold a Google identity to do authenticated Cloud Run invocation).
**If your org policy blocks public Cloud Run** (`allUsers` / domain-restricted
sharing), step 4 will be rejected — in that case we switch to either (a)
authenticated invoke called from GCP-hosted compute, or (b) moving Blak's chat
function onto Cloud Run so ADC works directly. Rotate the secret any time with:

```bash
gcloud run services update blak-vertex-proxy --region "$REGION" \
  --update-env-vars "PROXY_SECRET=$(openssl rand -hex 24)"
```
