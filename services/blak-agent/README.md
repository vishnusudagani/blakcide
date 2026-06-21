# Blak — group-voice mediator agent

A LiveKit **Agents** worker that joins the app's group voice rooms and speaks as
Blak (warm, quiet host/mediator) using **Gemini Live on Vertex** (ADC — no Google
API key, per org policy; draws GCP credits like the voice bridge).

- Every room in this LiveKit project is an app group call (`bg_<roomId>`), so the
  worker joins them all → Blak is present in every group voice call.
- Multi-party audio (mixing everyone for the model + publishing Blak's voice back)
  is handled by the LiveKit Agents framework + the Gemini realtime plugin.

## Deploy (once `gcloud auth login` is done)

```bash
cd services/blak-agent
PROJECT=handy-flame-499517-a1
REGION=us-central1

# Reuse the Vertex service account from the voice bridge (has roles/aiplatform.user).
gcloud run deploy blak-livekit-agent \
  --source . \
  --region "$REGION" \
  --service-account "blak-vertex-proxy@$PROJECT.iam.gserviceaccount.com" \
  --no-cpu-throttling --min-instances 1 --max-instances 2 \
  --no-allow-unauthenticated \
  --set-env-vars "GCP_PROJECT=$PROJECT,GCP_REGION=$REGION,LIVEKIT_URL=wss://blaksyd-t0uaetk2.livekit.cloud,LIVEKIT_API_KEY=APIipwzsYpnxVVt,LIVEKIT_API_SECRET=<SECRET>,GEMINI_LIVE_MODEL=gemini-live-2.5-flash"
```

Notes / things to tune on first deploy:
- **`--no-cpu-throttling --min-instances 1`** — it's a persistent worker (connects
  out to LiveKit, waits for room jobs), not request-driven; it must stay warm with
  CPU always allocated.
- **`GEMINI_LIVE_MODEL`** — the Vertex Gemini Live model id; align with the bridge's
  `VERTEX_LIVE_MODEL` (native-audio family). Adjust if the plugin rejects the id.
- **`BLAK_VOICE`** (default `Puck`) — Blak's group-call voice.
- The Vertex SA needs `roles/aiplatform.user` (blak-vertex-proxy already has it).

## Verify
- `gcloud run services logs read blak-livekit-agent --region us-central1` → should
  show the worker registered with LiveKit.
- Join a group's voice call from two browsers; Blak should be a participant and
  respond when addressed.
