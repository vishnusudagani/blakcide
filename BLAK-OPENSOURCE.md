# Blak on open-source LLMs (Echo → Blak re-platform)

"Echo" (the old codename for **Blak**) ran on OpenAI: `gpt-4o-realtime` (calls),
`gpt-4o` (chat), `whisper-1` (STT), `tts-1` (TTS). This moves Blak to **100%
open-source models**, all cloud-hosted (runs with your laptop closed). No OpenAI.

## What changed

### Phase 1 — Chat + voice notes ✅ (verified locally, not deployed)
| File | Before → After |
|------|----------------|
| `symp-core/lib/llm-providers.mjs` *(new)* | OpenAI-compatible router: OpenRouter Qwen 2.5 72B → Together/Fireworks/DeepInfra → **Groq/Llama 3.3 70B floor** |
| `symp-core/lib/chat-runner.mjs` | Provider failover; SSE + tool loop + meta-cards preserved |
| `netlify/functions/symp-v1-chat.mjs` | `gpt-4o` → router |
| `netlify/functions/chat-stream.mjs` | `gpt-4o` → router |
| `symp-core/lib/tools.mjs` (`search_web`) | `gpt-4o-search-preview` → OpenRouter `:online` |
| `netlify/functions/transcribe.js` | `whisper-1` → **Groq `whisper-large-v3`** |
| `netlify/functions/tts.js` | `tts-1` → **voice-infer** (OmniVoice/Parler) |

**Verified:** `node --check` on all touched files; in-process e2e of `/api/chat`
(streaming + non-streaming) on Groq; runner integration test (streaming, tool
round, `swap_persona` meta-card, Telugu/Hindi mirroring). No OpenAI strings remain.

### Phase 2 — Realtime calls 🏗️ (scaffolded; needs LiveKit + voice-infer to go live)
- `../../T2M_Application/T2M_App/voice-call/` — LiveKit Agents worker (Silero VAD + barge-in, Groq Whisper, Qwen/Llama, voice-infer TTS, per-turn language detect). See its README.
- `netlify/functions/livekit-token.mjs` *(new)* — mints LiveKit join tokens (replaces `realtime-session.js`).
- `app/blak-call-livekit.js` *(new)* — LiveKit browser client (kept separate from the existing call so nothing breaks until validated).

## Env to set on Netlify
```
# Chat + search (Phase 1)
GROQ_API_KEY=...            # works today (only live key)
OPENROUTER_API_KEY=...      # RECOMMENDED → Qwen 2.5 72B (brand parity w/ WhatsApp Blak) + web search
# Voice notes (Phase 1)
VOICE_INFER_URL=...         # deploy ../voice-infer to Modal
VOICE_INFER_SECRET=...
# Calls (Phase 2)
LIVEKIT_URL=wss://...livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```
Then `npm install` (adds `livekit-server-sdk`).

## Deploy order
1. Set `GROQ_API_KEY` (+ ideally `OPENROUTER_API_KEY`) on Netlify → **chat works** on deploy.
2. Deploy `voice-infer` to Modal; set `VOICE_INFER_URL`/`SECRET` → **voice notes work**.
3. Create LiveKit project; set `LIVEKIT_*`; run the `voice-call` worker on a cloud host; wire the call button to `BlakCall.start()` → **calls work**.

## ⚠️ Action items / gotchas
- **Get a clean Qwen key.** Today only `GROQ_API_KEY` is valid, so chat runs on Llama 3.3 70B. `OPENROUTER_API_KEY`/`TOGETHER_API_KEY` are empty; `FIREWORKS_API_KEY`/`DEEPINFRA_API_KEY` in `supabase/functions/.env` are **placeholder strings** (literal `⬜`/`→` chars) — this also means WhatsApp Blak is silently falling back off Qwen. Re-paste real keys.
- **Voice output needs voice-infer deployed** (Modal GPU). `tts.js` returns 503 until `VOICE_INFER_URL` is set — by design, no OpenAI fallback.
- **Calls need the spike** (Groq Whisper te/hi accuracy; streaming-TTS latency) — see `voice-call/README.md`.
- Once calls are live, delete `netlify/functions/realtime-session.js` (the last OpenAI caller).
