// Minimal Gmail API client for receipt sync. Needs a gmail.readonly access
// token (from the OAuth backend). Used only by the edge function at runtime;
// the pure parser/facts modules don't depend on this, so they stay testable.

import type { ParsedEmail } from "./types.ts";

const RECEIPT_QUERY =
  "from:(swiggy.in OR swiggy.com OR zomato.com OR blinkit.com OR grofers.com OR zeptonow.com OR uber.com OR olacabs.com OR rapido.bike) newer_than:180d";

interface GmailHeader { name: string; value: string; }
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; }
interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[]; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
}

function b64urlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") return decodeURIComponent(escape(atob(b64)));
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(payload: GmailMessage["payload"]): string {
  if (!payload) return "";
  if (payload.body?.data && (!payload.parts || payload.parts.length === 0)) {
    const raw = b64urlDecode(payload.body.data);
    return (payload.mimeType === "text/html" ? stripHtml(raw) : raw).slice(0, 20000);
  }
  let plain = "";
  let html = "";
  const walk = (p?: GmailPart) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) plain += b64urlDecode(p.body.data) + "\n";
    else if (p.mimeType === "text/html" && p.body?.data) html += b64urlDecode(p.body.data) + "\n";
    p.parts?.forEach(walk);
  };
  payload.parts?.forEach(walk);
  return (plain.trim() || stripHtml(html)).slice(0, 20000);
}

const header = (headers: GmailHeader[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

export async function listReceiptMessageIds(token: string, max = 60): Promise<string[]> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(RECEIPT_QUERY)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail list ${res.status}`);
  const j = (await res.json()) as { messages?: { id: string }[] };
  return (j.messages || []).map((m) => m.id);
}

export async function getMessage(token: string, id: string): Promise<ParsedEmail> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail get ${res.status}`);
  const m = (await res.json()) as GmailMessage;
  const headers = m.payload?.headers;
  const dateMs = m.internalDate ? Number(m.internalDate) : Date.now();
  return {
    id: m.id,
    from: header(headers, "From"),
    subject: header(headers, "Subject"),
    date: new Date(dateMs).toISOString(),
    text: extractBody(m.payload),
  };
}

export async function fetchReceipts(token: string, max = 60): Promise<ParsedEmail[]> {
  const ids = await listReceiptMessageIds(token, max);
  const out: ParsedEmail[] = [];
  for (const id of ids) {
    try {
      out.push(await getMessage(token, id));
    } catch {
      /* skip a message that fails to fetch */
    }
  }
  return out;
}
