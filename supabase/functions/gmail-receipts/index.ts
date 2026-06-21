// gmail-receipts — sync a user's order/ride receipts from Gmail into learned
// facts. Owner-scoped: the JWT identifies the user; facts are written to THEIR
// rows only. The Gmail access token comes from a server-only store added with
// the OAuth backend — until then this returns gmail_not_connected, but a debug
// body of { messages: [...] } drives the full parse -> facts -> write pipeline
// (useful for testing the pipeline before OAuth is live).

import { admin } from "../_shared/supabase.ts";
import { fetchReceipts } from "../_shared/receipts/gmail.ts";
import { parseEmails } from "../_shared/receipts/parse.ts";
import { deriveFacts } from "../_shared/receipts/facts.ts";
import type { ParsedEmail } from "../_shared/receipts/types.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// TODO(foundation): read the user's stored gmail.readonly access token from a
// server-only token store (refresh via the saved refresh token). Returns null
// until the Google OAuth backend is wired.
async function getGmailToken(_userId: string): Promise<string | null> {
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "unauthorized" }, 401);

  const db = admin();
  const { data: userData, error: userErr } = await db.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: { messages?: ParsedEmail[] } = {};
  try { body = await req.json(); } catch { /* no body */ }

  // Source the emails: a debug batch (manual ingest) or live Gmail.
  let emails: ParsedEmail[];
  if (Array.isArray(body.messages) && body.messages.length) {
    emails = body.messages;
  } else {
    const token = await getGmailToken(user.id);
    if (!token) return json({ ok: false, reason: "gmail_not_connected" });
    emails = await fetchReceipts(token);
  }

  const orders = parseEmails(emails);
  const facts = deriveFacts(orders);

  // Upsert facts as Blak-inferred knowledge (idempotent on user_id, area, key).
  if (facts.length) {
    const now = new Date().toISOString();
    const rows = facts.map((f) => ({
      user_id: user.id, area: f.area, key: f.key, label: f.label,
      value: f.value, source: "blak", confidence: f.confidence,
      status: "active", evidence: f.evidence, last_seen_at: now,
    }));
    await db.from("symp_knowledge_facts").upsert(rows, { onConflict: "user_id,area,key" });
  }

  // Mark the Gmail integration as learning.
  await db.from("symp_integrations").upsert({
    user_id: user.id, provider: "gmail", category: "account",
    status: "learning", last_sync_at: new Date().toISOString(),
  }, { onConflict: "user_id,provider" });

  return json({ ok: true, scanned: emails.length, parsed: orders.length, facts: facts.length });
});
