// Shared types for the Blak-on-WhatsApp Edge Functions.
//
// One brain, many channels. These types describe the channel store
// (blak_identities / blak_conversations / blak_messages) and the in-flight
// shapes the webhook passes between modules. The vault/persona/vibe brain
// tables are read as loosely-typed rows and narrowed where used.

export type LangLane = "te" | "hi" | "en" | "romanized-te" | "romanized-hi";

export type Channel = "whatsapp" | "app" | "voice";

export type Role = "user" | "assistant" | "system";

export type Direction = "inbound" | "outbound";

/** A row of public.blak_identities. */
export interface Identity {
  id: string;
  wa_id: string;
  user_id: string | null;
  display_name: string | null;
  flags: Record<string, unknown>;
  linked_at: string | null;
  link_method: string | null;
  created_at: string;
  updated_at: string;
}

/** A row of public.blak_conversations. */
export interface Conversation {
  id: string;
  identity_id: string;
  user_id: string | null;
  channel: Channel;
  title: string | null;
  category: string | null;
  categories: string[];
  summary: string | null;
  last_user_inbound_at: string | null;
  last_message_at: string | null;
  message_count: number;
  started_at: string;
}

/** A normalized inbound WhatsApp message, post-parse. */
export interface InboundMessage {
  waMessageId: string; // wamid.* — idempotency key
  from: string; // sender wa_id (E.164 digits, no '+')
  profileName: string | null;
  timestamp: number; // unix seconds from Meta
  type: string; // text | image | audio | document | sticker | ...
  text: string; // best-effort text (caption for media, empty for unsupported)
  mediaType: string | null;
  mediaId: string | null;
}

/** Minimal chat-turn shape handed to the LLM router. */
export interface ChatTurn {
  role: Role;
  content: string;
}

/** Assembled brain context for one user, ready to render into the prompt. */
export interface BrainContext {
  identity: Identity;
  conversation: Conversation;
  vault: Record<string, unknown> | null; // symp_vault_profiles row
  personaState: Record<string, unknown> | null; // symp_persona_state row
  personaFacts: Record<string, unknown>; // merged facts jsonb for active persona
  vibe: Record<string, unknown> | null; // symp_vibe_state row
  recentTurns: ChatTurn[]; // last N messages, oldest→newest
  retrieved: string[]; // optional embedding-retrieved memory snippets
  activePersona: string; // 'friend' by default
  lang: LangLane;
  missingProfileFields: string[]; // fields Blak could organically learn next
}
