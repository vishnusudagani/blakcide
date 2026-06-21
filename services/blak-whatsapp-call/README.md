# Blak on WhatsApp — voice call bridge (Pipecat + Gemini Live)

Answers **WhatsApp Business Calling API** voice calls and talks as **Blak** using
**Gemini Live** (native audio) — a 1:1 sibling of `services/blak-agent` (the LiveKit
group-voice agent).

```
WhatsApp caller ──WebRTC (Opus)──▶ this service (SmallWebRTCTransport)
                                      │
        Netlify whatsapp-webhook ─────┘  (routes 'calls' events here)
                                      ▼
                              Gemini Live (native audio) ── Blak's voice ──▶ caller
```

## Status: SKELETON (built, not yet deployable end-to-end)

It **cannot be tested until the real number is eligible** for calling:
1. `7702063434` migrated onto the Cloud API (pending **Meta business verification**, ~2 business days), AND
2. the number reaches the **≥ 2,000 business-initiated conversations / 24h** messaging tier (ramps with real usage), AND
3. calling enabled in **WhatsApp Manager → number → Calls**.

## Pieces
- `server.py` — FastAPI front door: `/whatsapp` GET verify + POST `calls` events; validates the signature; accepts the call via the Graph API (SDP answer); spawns the bot.
- `bot.py` — the Pipecat pipeline: `SmallWebRTCTransport` ↔ `GeminiMultimodalLiveLLMService`.
- `bot_prompt.py` — Blak's call persona (condensed from `symp-core/lib/system-prompt.mjs`).

## TODOs to finish at deploy (marked in code)
1. **Wire SmallWebRTC offer→answer** in `server.py` `connect` branch (exact API per the pinned Pipecat version + `daily-co/pcc-gemini-whatsapp`).
2. **Confirm Pipecat extras/imports** in `requirements.txt` / `bot.py`.
3. **Pick the Gemini Live backend:** AI Studio (`GEMINI_LIVE_API_KEY`, current default) vs **Vertex/ADC** (no key, draws GCP credits — matches `blak-agent`; preferred per the org's no-Google-keys policy).
4. **Personalize:** fetch the caller's full system stack (persona/vibe/vault/knowledge) from a Node endpoint by phone/user_id so a call has the same memory as their chats.
5. **TURN/ICE:** reuse the app's ICE servers (`netlify/functions/ice-servers.js` / METERED) for reliable media.

## Env (Cloud Run)
| Var | Notes |
|---|---|
| `GEMINI_LIVE_API_KEY` | AI Studio native-audio key (or switch to Vertex ADC) |
| `WHATSAPP_TOKEN` | permanent token (same as the chat channel) |
| `WHATSAPP_PHONE_NUMBER_ID` | the real number's ID (post-migration) |
| `WHATSAPP_APP_SECRET` | webhook signature verification |
| `WHATSAPP_VERIFY_TOKEN` | GET-handshake token |
| `WHATSAPP_GRAPH_VERSION` | default `v21.0` |
| `BLAK_VOICE` | default `Charon` |

## Deploy (Cloud Run, when eligible)
```bash
cd services/blak-whatsapp-call
PROJECT=handy-flame-499517-a1; REGION=us-central1
gcloud run deploy blak-whatsapp-call \
  --source . --region "$REGION" \
  --service-account "blak-vertex-proxy@$PROJECT.iam.gserviceaccount.com" \
  --no-cpu-throttling --min-instances 1 \
  --set-env-vars "GEMINI_LIVE_API_KEY=...,WHATSAPP_TOKEN=...,WHATSAPP_PHONE_NUMBER_ID=...,WHATSAPP_APP_SECRET=...,WHATSAPP_VERIFY_TOKEN=...,BLAK_VOICE=Charon"
```
Then set Netlify env **`WHATSAPP_CALL_BRIDGE_URL`** = the Cloud Run URL, and in Meta subscribe the WABA to the **`calls`** webhook field. The Netlify webhook forwards `calls` events here; `messages` still go to the chat worker.

## Routing
One Meta callback URL (the Netlify webhook) handles both fields:
`messages` → `whatsapp-webhook-background` (chat) · `calls` → this service `/whatsapp` (set `WHATSAPP_CALL_BRIDGE_URL`).
