// blak-whatsapp — the inbound webhook. Blak, the friend, on WhatsApp.
//
// Flow per inbound message:
//   verify signature → ack fast → killswitch → firewall (redact secrets)
//   → resolve identity + conversation → dedupe + persist inbound
//   → assemble brain context → Qwen reply → send (gated on 24h window)
//   → persist outbound → fire-and-forget learning.
//
// Meta retries webhooks, so everything is idempotent on wamid. We reply 200
// quickly and do the heavy work in the background (EdgeRuntime.waitUntil) so
// Meta never times us out.

import { admin, aiKilled } from "../_shared/supabase.ts";
import {
  parseInbound,
  sendText,
  markRead,
  verifyChallenge,
  verifySignature,
} from "../_shared/whatsapp.ts";
import { inspect } from "../_shared/firewall.ts";
import { detectLang } from "../_shared/lang.ts";
import {
  getOrCreateConversation,
  persistMessage,
  resolveIdentity,
  touchConversation,
  windowWarm,
} from "../_shared/identity.ts";
import { assembleContext } from "../_shared/context.ts";
import { buildSystemPrompt } from "../_shared/prompt.ts";
import { chat, type LlmMessage } from "../_shared/llm.ts";
import { learnFromTurn } from "../_shared/learning.ts";
import type { InboundMessage } from "../_shared/types.ts";

// Background-task helper: use EdgeRuntime.waitUntil when present so the heavy
// pipeline survives after we return 200; otherwise just run it.
// deno-lint-ignore no-explicit-any
const bg = (p: Promise<unknown>) => {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  else p.catch(() => {});
};

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ── GET: Meta subscription handshake ──
  if (req.method === "GET") return verifyChallenge(url);

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Read raw body FIRST (signature is over raw bytes).
  const raw = await req.text();
  const ok = await verifySignature(raw, req.headers.get("x-hub-signature-256"));
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const messages = parseInbound(payload);

  // Ack immediately; process in the background so Meta never times out.
  if (messages.length > 0) bg(processBatch(messages));

  return new Response("ok", { status: 200 });
});

async function processBatch(messages: InboundMessage[]): Promise<void> {
  if (await aiKilled()) return; // maintenance pause — stay silent
  for (const msg of messages) {
    try {
      await handleOne(msg);
    } catch (err) {
      console.error("handleOne failed", msg.waMessageId, err);
    }
  }
}

async function handleOne(msg: InboundMessage): Promise<void> {
  if (!msg.from || !msg.waMessageId) return;
  const db = admin();

  // 1. Firewall — redact secrets before they touch storage or the model.
  const fw = inspect(msg.text);
  const safeText = fw.severity === "ok" ? msg.text : fw.sanitized;

  // 2. Identity + conversation.
  const identity = await resolveIdentity(db, msg.from, msg.profileName);
  const conversation = await getOrCreateConversation(db, identity);
  const lang = detectLang(msg.text);

  // 3. Persist inbound (idempotent on wamid). If already seen, stop.
  const isNew = await persistMessage(db, {
    conversationId: conversation.id,
    identityId: identity.id,
    userId: identity.user_id,
    role: "user",
    direction: "inbound",
    content: safeText || `[${msg.type}]`,
    waMessageId: msg.waMessageId,
    lang,
    mediaType: msg.mediaType,
  });
  if (!isNew) return; // Meta retry — we already handled this one.

  await touchConversation(db, conversation, { userInbound: true, delta: 1 });
  // Reflect the just-set window locally so windowWarm() is true below.
  conversation.last_user_inbound_at = new Date().toISOString();
  conversation.message_count += 1;

  markRead(msg.waMessageId); // fire-and-forget blue ticks

  // 4. Assemble live brain context (includes the recent turns).
  const ctx = await assembleContext(db, identity, conversation, lang);

  // 5. Generate Blak's reply.
  const system = buildSystemPrompt(ctx);
  const llmMessages: LlmMessage[] = [
    { role: "system", content: system },
    ...ctx.recentTurns.map((t) => ({
      role: t.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: t.content,
    })),
  ];

  let reply: string;
  try {
    const result = await chat(llmMessages, { temperature: 0.7, maxTokens: 500 });
    reply = result.text;
  } catch (err) {
    console.error("LLM failed for", identity.wa_id, err);
    // Graceful, human fallback — never leave a friend on read.
    reply = "hey, my head's a bit foggy right now 😅 give me a moment and say that again?";
  }

  // Firewall the outbound too (model should never echo a secret).
  const replyOut = inspect(reply).sanitized || reply;

  // 6. Send — only inside the 24h window (always true right after their msg).
  if (!windowWarm(conversation)) return;
  let sentId = "";
  try {
    sentId = await sendText(identity.wa_id, replyOut);
  } catch (err) {
    console.error("send failed", identity.wa_id, err);
    return;
  }

  // 7. Persist outbound + roll counters.
  await persistMessage(db, {
    conversationId: conversation.id,
    identityId: identity.id,
    userId: identity.user_id,
    role: "assistant",
    direction: "outbound",
    content: replyOut,
    waMessageId: sentId || null,
    lang,
    status: "sent",
  });
  await touchConversation(db, conversation, { userInbound: false, delta: 1 });

  // 8. Learn — after the reply is out, so it adds zero latency.
  bg(learnFromTurn(db, ctx, safeText, replyOut));
}
