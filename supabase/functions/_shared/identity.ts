// Identity + conversation resolution over the channel store.
//
// A WhatsApp user is keyed by phone (wa_id) and may have NO app account yet
// (shadow identity, user_id NULL). Conversations are gap-based: a fresh thread
// opens after a quiet gap so the app's categorised view stays readable. The 24h
// window anchor (last_user_inbound_at) lives on the conversation and gates ALL
// outbound — including proactive nudges — so we never trip a paid Meta template.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type {
  Conversation,
  Direction,
  Identity,
  InboundMessage,
  LangLane,
  Role,
} from "./types.ts";

// A new conversation thread opens if the last activity was longer ago than
// this. 6h keeps a back-and-forth in one thread while splitting genuinely
// separate sessions for the categorised app view.
const NEW_THREAD_GAP_MS = 6 * 60 * 60 * 1000;

// The Meta free-form window. Outbound is only allowed while warm.
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Upsert the identity for an inbound sender; refresh display name if changed. */
export async function resolveIdentity(
  db: SupabaseClient,
  waId: string,
  displayName: string | null,
): Promise<Identity> {
  const { data: existing } = await db
    .from("blak_identities")
    .select("*")
    .eq("wa_id", waId)
    .maybeSingle();

  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      await db
        .from("blak_identities")
        .update({ display_name: displayName })
        .eq("id", existing.id);
      existing.display_name = displayName;
    }
    return existing as Identity;
  }

  const { data, error } = await db
    .from("blak_identities")
    .insert({ wa_id: waId, display_name: displayName })
    .select("*")
    .single();
  if (error) throw new Error(`identity insert failed: ${error.message}`);
  return data as Identity;
}

/** Find the active thread for this identity, or open a fresh one. */
export async function getOrCreateConversation(
  db: SupabaseClient,
  identity: Identity,
): Promise<Conversation> {
  const { data: recent } = await db
    .from("blak_conversations")
    .select("*")
    .eq("identity_id", identity.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (recent) {
    const last = recent.last_message_at
      ? new Date(recent.last_message_at).getTime()
      : new Date(recent.started_at).getTime();
    if (Date.now() - last < NEW_THREAD_GAP_MS) {
      return recent as Conversation;
    }
  }

  const { data, error } = await db
    .from("blak_conversations")
    .insert({
      identity_id: identity.id,
      user_id: identity.user_id,
      channel: "whatsapp",
    })
    .select("*")
    .single();
  if (error) throw new Error(`conversation insert failed: ${error.message}`);
  return data as Conversation;
}

/** True while the 24h free-form window is open. The ONLY gate for outbound. */
export function windowWarm(conv: Conversation): boolean {
  if (!conv.last_user_inbound_at) return false;
  return Date.now() - new Date(conv.last_user_inbound_at).getTime() < WINDOW_MS;
}

export interface PersistArgs {
  conversationId: string;
  identityId: string;
  userId: string | null;
  role: Role;
  direction: Direction;
  content: string;
  waMessageId?: string | null;
  lang?: LangLane | null;
  mediaType?: string | null;
  status?: string;
}

/**
 * Persist a message. wa_message_id is unique, so a retried inbound webhook is a
 * no-op (returns false = "already seen", caller should skip processing).
 */
export async function persistMessage(
  db: SupabaseClient,
  args: PersistArgs,
): Promise<boolean> {
  const row = {
    conversation_id: args.conversationId,
    identity_id: args.identityId,
    user_id: args.userId,
    channel: "whatsapp" as const,
    role: args.role,
    direction: args.direction,
    content: args.content,
    wa_message_id: args.waMessageId ?? null,
    lang: args.lang ?? null,
    media_type: args.mediaType ?? null,
    status: args.status ?? (args.direction === "inbound" ? "received" : "sent"),
  };

  // Dedup on wamid for inbound. Upsert-ignore: conflict → no insert.
  const query = args.waMessageId
    ? db.from("blak_messages").upsert(row, {
        onConflict: "wa_message_id",
        ignoreDuplicates: true,
      }).select("id")
    : db.from("blak_messages").insert(row).select("id");

  const { data, error } = await query;
  if (error) throw new Error(`message persist failed: ${error.message}`);
  // upsert-ignore returns [] when the row already existed.
  return Array.isArray(data) ? data.length > 0 : true;
}

/** Roll the conversation counters + window anchor after a turn. */
export async function touchConversation(
  db: SupabaseClient,
  conv: Conversation,
  opts: { userInbound: boolean; delta: number },
): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    last_message_at: now,
    message_count: (conv.message_count ?? 0) + opts.delta,
  };
  if (opts.userInbound) patch.last_user_inbound_at = now;
  await db.from("blak_conversations").update(patch).eq("id", conv.id);
}

/** Recent turns for context, oldest→newest. */
export async function recentTurns(
  db: SupabaseClient,
  conversationId: string,
  limit = 16,
): Promise<{ role: Role; content: string }[]> {
  const { data } = await db
    .from("blak_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as { role: Role; content: string }[];
  return rows.reverse();
}
