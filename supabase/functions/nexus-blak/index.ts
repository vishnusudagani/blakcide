// nexus-blak — the community presence engine for Blak.
//
// Blak is ONE synthetic member of Nexus (not personalised to anyone) who shows
// up as a warm peer + light host. Two modes:
//   • default (cron, ~every 2h): make ONE light tribe move — reply to a fresh
//     human post Blak hasn't answered, or (rarely) start a gentle thread in a
//     quiet tribe. Rate-limited + daily-capped so it stays lightly present.
//   • room_opener {room_id}: greet a newly-created live room (realtime broadcast).
//
// Auth: fails CLOSED on a shared cron secret. Generation uses the same multi-
// provider OSS LLM router as the rest of Blak, and honours the global kill switch.
// Self-contained (no ../_shared imports) so it deploys as a single function.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const BLAK_UID = "b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab";
const DAILY_CAP = 6;            // max Blak posts+comments / 24h across all tribes
const TRIBE_COOLDOWN_H = 5;     // min hours between Blak actions in one tribe
const FRESH_POST_H = 36;        // only reply to posts newer than this
const QUIET_TRIBE_H = 24;       // a tribe silent this long may get a gentle starter

const SYSTEM =
  "You are Blak, a member of a small, warm online community called Nexus (part of Blaksyd). " +
  "You are NOT an assistant and NOT tied to any one person — you're just another member: warm, real, easy to be around. " +
  "Write like a thoughtful friend in a group chat: lowercase, casual, SHORT (1–2 sentences), an em dash now and then, an emoji only rarely. " +
  "Share a genuine, relatable reaction AND sometimes gently welcome someone or ask one light question to keep things alive. " +
  "Never sound clinical or like therapy. Never give medical or mental-health advice or crisis resources. Never say you're an AI. " +
  "Never use the person's name, never be salesy or preachy. Just be a good presence.";

// ── inlined service-role client + kill switch ──────────────────────────────
let _admin: SupabaseClient | null = null;
function admin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}
async function aiKilled(): Promise<boolean> {
  try {
    const { data } = await admin().from("global_settings").select("value").eq("key", "ai_voice_killswitch").maybeSingle();
    return !!((data?.value as { enabled?: boolean } | null)?.enabled);
  } catch { return false; }
}

// ── inlined multi-provider OSS LLM router (Groq is the free floor) ──────────
function providers() {
  return [
    { id: "gemini", endpoint: Deno.env.get("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-2.5-flash", apiKey: Deno.env.get("GEMINI_API_KEY") },
    { id: "together", endpoint: "https://api.together.xyz/v1/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct-Turbo", apiKey: Deno.env.get("TOGETHER_API_KEY") },
    { id: "fireworks", endpoint: "https://api.fireworks.ai/inference/v1/chat/completions", model: "accounts/fireworks/models/qwen2p5-72b-instruct", apiKey: Deno.env.get("FIREWORKS_API_KEY") },
    { id: "deepinfra", endpoint: "https://api.deepinfra.com/v1/openai/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct", apiKey: Deno.env.get("DEEPINFRA_API_KEY") },
    { id: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", apiKey: Deno.env.get("GROQ_API_KEY") },
  ].filter((p) => !!p.apiKey);
}
async function llm(userPrompt: string, maxTokens = 90): Promise<string> {
  const ps = providers();
  if (!ps.length) throw new Error("no LLM provider keys configured");
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt }];
  let lastErr = "";
  for (const p of ps) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(p.endpoint, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model, messages, temperature: 0.9, max_tokens: maxTokens }),
      });
      clearTimeout(timer);
      if (!res.ok) { lastErr = `${p.id}:${res.status}`; continue; }
      const j = await res.json();
      const text = (j?.choices?.[0]?.message?.content ?? "").trim().replace(/^["'`]|["'`]$/g, "");
      if (text) return text.slice(0, 600);
      lastErr = `${p.id}:empty`;
    } catch (e) { clearTimeout(timer); lastErr = `${p.id}:${(e as Error)?.message}`; }
  }
  throw new Error("all providers failed: " + lastErr);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function broadcast(topic: string, payload: unknown) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ topic, event: "msg", payload }] }),
  }).catch(() => {});
}

// ── greet a new live room ──────────────────────────────────────────────────
async function roomOpener(roomId: string) {
  const db = admin();
  const { data: room } = await db.from("nexus_rooms").select("id,title,topic").eq("id", roomId).maybeSingle();
  if (!room) return json({ ok: false, reason: "room_not_found" });
  let line = "hey — welcome in 👋";
  try {
    line = await llm(`Someone just opened a live room called "${room.title}"${room.topic ? ` (${room.topic})` : ""}. Greet the room warmly as the first friendly face, in one short line.`, 60) || line;
  } catch { /* fall back to the static greeting */ }
  await new Promise((r) => setTimeout(r, 2500)); // let the host's client subscribe first
  await broadcast(`nx-room:${roomId}`, { handle: "Blak", color: 0, text: line, is_ai: true });
  return json({ ok: true, mode: "room_opener", text: line });
}

// ── one light tribe move (cron) ────────────────────────────────────────────
async function tribeMove() {
  if (await aiKilled()) return json({ ok: true, skipped: "ai_killed" });
  const db = admin();
  const since = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  const [{ count: postsToday }, { count: commentsToday }] = await Promise.all([
    db.from("nexus_posts").select("id", { count: "exact", head: true }).eq("author_user_id", BLAK_UID).gte("created_at", since(24)),
    db.from("nexus_comments").select("id", { count: "exact", head: true }).eq("author_user_id", BLAK_UID).gte("created_at", since(24)),
  ]);
  if ((postsToday || 0) + (commentsToday || 0) >= DAILY_CAP) return json({ ok: true, skipped: "daily_cap" });

  const { data: tribes } = await db.from("nexus_communities").select("id,name,description").eq("visibility", "public");
  if (!tribes?.length) return json({ ok: true, skipped: "no_tribes" });

  const { data: recent } = await db.from("nexus_posts")
    .select("id,community_id,body,author_user_id,created_at,is_ai_author")
    .in("community_id", tribes.map((t: any) => t.id))
    .eq("is_soft_hidden", false).eq("is_ai_author", false)
    .gte("created_at", since(FRESH_POST_H))
    .order("created_at", { ascending: false }).limit(25);

  for (const post of recent || []) {
    if (!post.body || post.author_user_id === BLAK_UID) continue;
    const tribePostIds = (recent || []).filter((p: any) => p.community_id === post.community_id).map((p: any) => p.id);
    const { count: tribeActs } = await db.from("nexus_comments")
      .select("id", { count: "exact", head: true })
      .eq("author_user_id", BLAK_UID).gte("created_at", since(TRIBE_COOLDOWN_H)).in("post_id", tribePostIds);
    if ((tribeActs || 0) > 0) continue;
    const { count: mine } = await db.from("nexus_comments")
      .select("id", { count: "exact", head: true }).eq("post_id", post.id).eq("author_user_id", BLAK_UID);
    if ((mine || 0) > 0) continue;

    const tribe = tribes.find((t: any) => t.id === post.community_id);
    let reply = "";
    try { reply = await llm(`In the "${tribe?.name || "community"}" tribe, a member wrote:\n"${String(post.body).slice(0, 600)}"\n\nReply as a fellow member.`); } catch (e) { return json({ ok: false, error: String(e) }, 502); }
    if (!reply) return json({ ok: true, skipped: "empty_gen" });
    await db.from("nexus_comments").insert({ post_id: post.id, author_user_id: BLAK_UID, is_ai_author: true, body: reply });
    return json({ ok: true, mode: "comment", tribe: tribe?.name, text: reply });
  }

  for (const t of tribes) {
    const { data: last } = await db.from("nexus_posts").select("created_at").eq("community_id", t.id).order("created_at", { ascending: false }).limit(1);
    const quiet = !last?.length || last[0].created_at < since(QUIET_TRIBE_H);
    if (!quiet) continue;
    const { count: starterRecently } = await db.from("nexus_posts")
      .select("id", { count: "exact", head: true }).eq("community_id", t.id).eq("author_user_id", BLAK_UID).gte("created_at", since(QUIET_TRIBE_H));
    if ((starterRecently || 0) > 0) continue;
    let body = "";
    try { body = await llm(`Start a light, warm conversation in the "${t.name}" tribe${t.description ? ` (about: ${t.description})` : ""}. One short, inviting post.`); } catch { continue; }
    if (!body) continue;
    await db.from("nexus_posts").insert({ community_id: t.id, author_user_id: BLAK_UID, is_ai_author: true, body });
    return json({ ok: true, mode: "starter", tribe: t.name, text: body });
  }

  return json({ ok: true, skipped: "nothing_to_do" });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("NEXUS_BLAK_CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  let body: { mode?: string; room_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body = cron tribe move */ }
  try {
    if (body.mode === "room_opener" && body.room_id) return await roomOpener(body.room_id);
    return await tribeMove();
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
