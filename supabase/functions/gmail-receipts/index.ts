// gmail-receipts — sync a user's order/ride receipts from Gmail into learned
// facts. Owner-scoped: the JWT identifies the user; facts are written to THEIR
// rows only. The Gmail access token comes from the server-only token store
// (filled by the gmail-oauth-callback flow). A debug body of { messages: [...] }
// drives the full parse -> facts -> write pipeline without Gmail (for testing).

import { admin, getUserFromRequest } from "../_shared/supabase.ts";
import { fetchReceipts } from "../_shared/receipts/gmail.ts";
import { parseEmail } from "../_shared/receipts/parse.ts";
import { deriveFacts } from "../_shared/receipts/facts.ts";
import type { ParsedEmail, Order } from "../_shared/receipts/types.ts";
import { getGmailToken } from "../_shared/google-oauth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const user = await getUserFromRequest(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const db = admin();

  let body: { messages?: ParsedEmail[] } = {};
  try { body = await req.json(); } catch { /* no body */ }

  // Source the emails: a debug batch (manual ingest) or live Gmail.
  let emails: ParsedEmail[];
  if (Array.isArray(body.messages) && body.messages.length) {
    emails = body.messages;
  } else {
    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    const token = clientId && clientSecret
      ? await getGmailToken(db, user.id, clientId, clientSecret)
      : null;
    if (!token) return json({ ok: false, reason: "gmail_not_connected" });
    emails = await fetchReceipts(token);
  }

  // Parse + collect diagnostics (TEMPORARY, for tuning extractors to real email
  // formats). Logs sender/subject/extracted-fields/snippet of the user's own
  // receipts to this project's function logs; remove once extractors are tuned.
  const orders: Order[] = [];
  const diag: Record<string, unknown>[] = [];
  for (const e of emails) {
    const o = parseEmail(e);
    if (o) orders.push(o);
    if (diag.length < 40) {
      diag.push({
        from: (e.from || "").slice(0, 70),
        subject: (e.subject || "").slice(0, 90),
        provider: o ? o.provider : "unmatched",
        amt: o ? o.amountInr : null,
        merchant: o ? o.merchant : null,
        dest: o ? o.destination : null,
        items: o ? o.items.length : 0,
        snippet: (e.text || "").replace(/\s+/g, " ").slice(0, 220),
      });
    }
  }
  const facts = deriveFacts(orders);
  console.log(`gmail-receipts diag: scanned=${emails.length} parsed=${orders.length} facts=${facts.length}`);
  for (const d of diag) console.log("RCPT " + JSON.stringify(d));

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
