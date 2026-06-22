// push-send — Phase 5 web push. Sends a notification to all of a user's
// subscriptions. Called by DB triggers via pg_net with the shared cron secret;
// fails CLOSED. Prunes dead subscriptions (404/410). WhatsApp delivery dropped.
import webpush from "npm:web-push@3.6.7";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
}
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  const secret = Deno.env.get("NEXUS_BLAK_CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);

  let p: Record<string, unknown> = {};
  try { p = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const userId = String(p.user_id || "");
  if (!userId) return json({ ok: false, error: "no user_id" }, 400);

  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subj = Deno.env.get("VAPID_SUBJECT") || "mailto:assist@blaksyd.com";
  if (!pub || !priv) return json({ ok: false, error: "vapid not configured" }, 500);
  try { webpush.setVapidDetails(subj, pub, priv); } catch (e) { return json({ ok: false, error: "vapid: " + String(e) }, 500); }

  const db = admin();
  const { data: subs } = await db.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", userId);
  if (!subs || !subs.length) return json({ ok: true, sent: 0 });

  const payload = JSON.stringify({ title: p.title || "Blaksyd", body: p.body || "", url: p.url || "/beta/", tag: p.tag });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: (s as any).endpoint, keys: { p256dh: (s as any).p256dh, auth: (s as any).auth } }, payload);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) { try { await db.from("push_subscriptions").delete().eq("endpoint", (s as any).endpoint); } catch { /* ignore */ } }
    }
  }
  return json({ ok: true, sent });
});
