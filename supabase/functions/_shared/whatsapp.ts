// WhatsApp Cloud API client — Meta Graph API.
//
// Inbound: Meta POSTs webhooks signed with X-Hub-Signature-256 (HMAC-SHA256 of
// the RAW body using the App Secret). We verify before trusting anything, and
// dedupe on wamid (Meta RETRIES delivery). Outbound: send free-form session
// messages via the Graph API — free while inside the 24h customer-service
// window. We never send paid template messages from here by default.

import type { InboundMessage } from "./types.ts";

const GRAPH_VERSION = "v21.0";

// ─── Webhook verification (GET subscription handshake) ──────────────────────

/**
 * Meta's GET challenge when you (re)subscribe the webhook. Echo hub.challenge
 * iff the verify token matches the one we set in the App dashboard.
 */
export function verifyChallenge(url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = Deno.env.get("WHATSAPP_VERIFY_TOKEN");

  if (mode === "subscribe" && token && token === expected && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ─── Signature verification (POST authenticity) ─────────────────────────────

/**
 * Verify X-Hub-Signature-256 against the raw request body using the App Secret.
 * MUST be called on the raw bytes, before JSON.parse. Constant-time compare.
 */
export async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expectedHex = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const actualHex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(actualHex, expectedHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Inbound parsing ────────────────────────────────────────────────────────

/**
 * Flatten a webhook payload into normalized inbound messages. Status-only
 * callbacks (delivered/read receipts) yield an empty array.
 */
export function parseInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value) continue;

      const contacts = (value.contacts as unknown[]) ?? [];
      const profileName =
        ((contacts[0] as { profile?: { name?: string } })?.profile?.name) ??
        null;

      const messages = (value.messages as Record<string, unknown>[]) ?? [];
      for (const m of messages) {
        const type = String(m.type ?? "unknown");
        const text = extractText(m, type);
        const media = extractMedia(m, type);
        out.push({
          waMessageId: String(m.id ?? ""),
          from: String(m.from ?? ""),
          profileName,
          timestamp: Number(m.timestamp ?? 0),
          type,
          text,
          mediaType: media?.type ?? null,
          mediaId: media?.id ?? null,
        });
      }
    }
  }
  return out;
}

function extractText(m: Record<string, unknown>, type: string): string {
  if (type === "text") return String((m.text as { body?: string })?.body ?? "");
  // Media captions, button/interactive replies → best-effort text.
  const caption = (m[type] as { caption?: string })?.caption;
  if (caption) return String(caption);
  const btn = (m.button as { text?: string })?.text;
  if (btn) return String(btn);
  const inter = m.interactive as
    | { button_reply?: { title?: string }; list_reply?: { title?: string } }
    | undefined;
  if (inter?.button_reply?.title) return String(inter.button_reply.title);
  if (inter?.list_reply?.title) return String(inter.list_reply.title);
  return "";
}

function extractMedia(
  m: Record<string, unknown>,
  type: string,
): { type: string; id: string } | null {
  if (["image", "audio", "video", "document", "sticker"].includes(type)) {
    const id = (m[type] as { id?: string })?.id;
    if (id) return { type, id };
  }
  return null;
}

// ─── Outbound ───────────────────────────────────────────────────────────────

/**
 * Send a free-form text message. Valid only inside the 24h window — callers
 * MUST gate on the conversation window before calling this (see identity.ts).
 * Returns the wamid of the sent message, or throws on API error.
 */
export async function sendText(toWaId: string, body: string): Promise<string> {
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!phoneNumberId || !token) {
    throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN");
  }

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toWaId,
        type: "text",
        text: { preview_url: false, body: body.slice(0, 4096) },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return String(data?.messages?.[0]?.id ?? "");
}

/** Mark an inbound message read (the blue ticks) — best-effort, never throws. */
export async function markRead(waMessageId: string): Promise<void> {
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!phoneNumberId || !token || !waMessageId) return;
  try {
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: waMessageId,
        }),
      },
    );
  } catch {
    /* read receipts are non-critical */
  }
}
