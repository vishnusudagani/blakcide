# Blak on WhatsApp — Edge Functions

Blak (the friend from the Blaksyd app) on the verified WhatsApp Business number
**+91 7702063434**, via Meta's WhatsApp Cloud API. Same brain as the app —
WhatsApp is just one channel. Built on Supabase Edge Functions (Deno) so it
lives next to the brain and stays globally available.

## The design rules (non-negotiable)

1. **User messages first.** Blak never cold-opens a brand-new contact.
2. **Proactive only while warm.** Outbound (including proactive nudges) is sent
   ONLY inside the 24h customer-service window. When cold, Blak goes silent and
   waits — **no paid template messages by default.** This is enforced in code
   (`windowWarm()` gates every send).
3. **One brain.** WhatsApp turns feed the same vault pipeline the app reads
   (`symp_persona_facts`, `symp_session_summaries`). On app login,
   `blak_link_identity()` backfills history so the user sees all chats,
   categorised.
4. **Learn like a friend, not a salesperson.** Facts are extracted silently;
   Blak shows curiosity about at most one thing, only when natural.
5. **Open-source model, no downtime.** Qwen 2.5 72B via Together → Fireworks →
   DeepInfra failover. Same model everywhere, so failover is invisible.

## Layout

```
functions/
  _shared/
    types.ts        shared types
    supabase.ts     service-role client + killswitch
    llm.ts          Qwen router w/ multi-provider failover
    firewall.ts     OTP/card/SSN redaction (rule-based, runs before model)
    lang.ts         te/hi/en/romanized detection + mirroring instruction
    whatsapp.ts     Graph API: verify, parse inbound, send, mark read
    identity.ts     phone→user, conversations, 24h window, persistence
    context.ts      reads the brain, renders prompt context
    prompt.ts       Blak's system prompt (+ proactive variant)
    learning.ts     fact extraction, categorisation, session summaries
  blak-whatsapp/    the inbound webhook
  blak-proactive/   pg_cron-driven proactive engine (window-aware)
```

Schema lives in `../migrations/20260612_blak_whatsapp.sql` (channel store) and
`../migrations/20260612_blak_proactive_cron.sql` (schedule).

## Deploy

```bash
# 1. Apply schema
supabase db push

# 2. Set secrets (fill in supabase/functions/.env from .env.example first)
supabase secrets set --env-file supabase/functions/.env

# 3. Deploy functions
supabase functions deploy blak-whatsapp
supabase functions deploy blak-proactive

# 4. In Meta App dashboard → WhatsApp → Configuration → Webhook:
#    Callback URL: https://<PROJECT_REF>.supabase.co/functions/v1/blak-whatsapp
#    Verify token: the WHATSAPP_VERIFY_TOKEN you set
#    Subscribe to the "messages" field.

# 5. Wire the cron secrets in Vault (see the cron migration header), then it
#    self-schedules every 15 min.
```

## How a message flows

```
user → Meta → blak-whatsapp
  verify signature → 200 ack → (background:)
  killswitch? → firewall redact → identity + conversation
  → dedupe+persist inbound → assemble brain context
  → Qwen reply → send (if window warm) → persist outbound
  → fire-and-forget learning (facts, category, summary)
```

## Account-safety notes

Cloud API + automation is Meta-sanctioned (unlike automating the consumer app).
The one metric that matters is **quality rating** (WhatsApp Manager) — keep
proactive messages genuinely friend-like and honor `flags.opted_out`. New
numbers start at a low messaging tier and ramp with good quality; don't
mass-onboard on day one.
