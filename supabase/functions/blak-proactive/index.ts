// blak-proactive — Blak reaches out first, the way a friend does.
//
// Invoked on a schedule (pg_cron, see migration). It reads DUE triggers from
// the existing symp_action_loop queue and, for each, sends ONE warm opener —
// but ONLY if that user's WhatsApp conversation is still inside the 24h
// free-form window. If the window is cold, we SKIP (status 'cancelled') rather
// than send a paid Meta template. This is the hard rule: proactivity never
// costs a template fee.
//
// Secured by a shared secret header (CRON_SECRET) so only the scheduler can
// fire it.

import { admin, aiKilled } from "../_shared/supabase.ts";
import { sendText } from "../_shared/whatsapp.ts";
import {
  persistMessage,
  touchConversation,
  windowWarm,
} from "../_shared/identity.ts";
import { assembleContext } from "../_shared/context.ts";
import { buildProactivePrompt } from "../_shared/prompt.ts";
import { chat, type LlmMessage } from "../_shared/llm.ts";
import type { Conversation, Identity } from "../_shared/types.ts";

const MAX_PER_RUN = 50; // safety cap; ramp slowly to protect quality rating

Deno.serve(async (req) => {
  // Only the scheduler may invoke this.
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  if (await aiKilled()) {
    return Response.json({ skipped: "killswitch" });
  }

  const db = admin();
  const nowIso = new Date().toISOString();

  // Pull due, pending triggers.
  const { data: due } = await db
    .from("symp_action_loop")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(MAX_PER_RUN);

  const triggers = (due ?? []) as Array<{
    id: string;
    user_id: string;
    trigger_type: string;
    payload: Record<string, unknown>;
  }>;

  let sent = 0;
  let skippedCold = 0;
  let skippedNoChannel = 0;

  for (const t of triggers) {
    try {
      // Find this user's WhatsApp identity + latest conversation.
      const { data: identity } = await db
        .from("blak_identities")
        .select("*")
        .eq("user_id", t.user_id)
        .maybeSingle();

      if (!identity || (identity as Identity).flags?.["opted_out"]) {
        await finish(db, t.id, "cancelled", { reason: "no_channel_or_opted_out" });
        skippedNoChannel++;
        continue;
      }

      const { data: conv } = await db
        .from("blak_conversations")
        .select("*")
        .eq("identity_id", (identity as Identity).id)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      // THE rule: only reach out if the free-form window is still warm.
      if (!conv || !windowWarm(conv as Conversation)) {
        await finish(db, t.id, "cancelled", { reason: "window_cold_no_paid_template" });
        skippedCold++;
        continue;
      }

      await deliverProactive(
        db,
        identity as Identity,
        conv as Conversation,
        t.trigger_type,
      );
      await finish(db, t.id, "fired", { delivered: true });
      sent++;
    } catch (err) {
      await finish(db, t.id, "failed", { error: String(err).slice(0, 200) });
    }
  }

  return Response.json({
    considered: triggers.length,
    sent,
    skippedCold,
    skippedNoChannel,
  });
});

async function deliverProactive(
  // deno-lint-ignore no-explicit-any
  db: any,
  identity: Identity,
  conv: Conversation,
  trigger: string,
): Promise<void> {
  const ctx = await assembleContext(db, identity, conv, "en");
  const system = buildProactivePrompt(ctx, trigger);

  const llmMessages: LlmMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        "(Write the opener now — one short, warm WhatsApp message reaching out first.)",
    },
  ];

  const { text } = await chat(llmMessages, { temperature: 0.8, maxTokens: 200 });
  const sentId = await sendText(identity.wa_id, text);

  await persistMessage(db, {
    conversationId: conv.id,
    identityId: identity.id,
    userId: identity.user_id,
    role: "assistant",
    direction: "outbound",
    content: text,
    waMessageId: sentId || null,
    status: "sent",
  });
  // Outbound only — do NOT touch last_user_inbound_at (window unchanged).
  await touchConversation(db, conv, { userInbound: false, delta: 1 });
}

async function finish(
  // deno-lint-ignore no-explicit-any
  db: any,
  id: string,
  status: "fired" | "cancelled" | "failed",
  result: Record<string, unknown>,
): Promise<void> {
  await db
    .from("symp_action_loop")
    .update({ status, fired_at: new Date().toISOString(), result })
    .eq("id", id);
}
