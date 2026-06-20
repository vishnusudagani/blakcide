// nexus-learn — Learning loop Phase 2. NIGHTLY (Nexus is refresh-based, not
// realtime, so a daily batch is the right cadence). For each user with recent
// Nexus posts/comments, distil a FEW durable interest/values facts and upsert
// them into the knowledge profile via knowledge_upsert (source 'nexus', never
// sensitive — interests live in the public-feed lane, not Blak's private one).
//
// Strictly abstracted: no verbatim, no clinical labels, no other people's names.
// Fails CLOSED on the shared cron secret; honours the global AI kill switch.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const BLAK_UID = "b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab";
const MAX_USERS = 25;        // per nightly run
const LOOKBACK_H = 26;       // a day + a little overlap (reinforcement handles dupes)
const MAX_CHARS = 6000;      // per-user text fed to the model

const SYSTEM =
  "You quietly build a respectful INTERESTS profile from what someone shares in their online communities. " +
  "From this person's own posts/comments below, extract a FEW durable facts about what they're into, what they value, and topics they care about. " +
  "Output ONLY JSON: {\"facts\":[{\"area\":\"...\",\"key\":\"...\",\"value\":\"...\"}]}. " +
  "area ∈ tastes (interests/hobbies/likes), world (values/worldview/opinions), goals (aspirations), people (relationships — ROLES only), identity (who they are), other. " +
  "key = a short stable lowercase slug (e.g. 'trail-running'). value = a short plain statement ('into trail running', 'values blunt honesty'). " +
  "RULES: abstracted only — NO verbatim quotes; NO clinical/diagnostic/mental-health labels; NEVER name another person (use roles like 'a close friend'); " +
  "SKIP anything emotional, vulnerable, or sensitive (that's a different lane); only what you're genuinely confident about; 0 to 5 items; an empty list is fine.";

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
function providers() {
  return [
    { id: "gemini", endpoint: Deno.env.get("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-2.5-flash", apiKey: Deno.env.get("GEMINI_API_KEY") },
    { id: "together", endpoint: "https://api.together.xyz/v1/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct-Turbo", apiKey: Deno.env.get("TOGETHER_API_KEY") },
    { id: "fireworks", endpoint: "https://api.fireworks.ai/inference/v1/chat/completions", model: "accounts/fireworks/models/qwen2p5-72b-instruct", apiKey: Deno.env.get("FIREWORKS_API_KEY") },
    { id: "deepinfra", endpoint: "https://api.deepinfra.com/v1/openai/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct", apiKey: Deno.env.get("DEEPINFRA_API_KEY") },
    { id: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", apiKey: Deno.env.get("GROQ_API_KEY") },
  ].filter((p) => !!p.apiKey);
}
async function llmJson(userText: string): Promise<any | null> {
  const ps = providers();
  if (!ps.length) throw new Error("no LLM provider keys configured");
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: userText }];
  for (const p of ps) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await fetch(p.endpoint, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model, messages, temperature: 0.3, max_tokens: 500, response_format: { type: "json_object" } }),
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j = await res.json();
      let txt = (j?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json\s*|\s*```$/g, "");
      try { const o = JSON.parse(txt); if (o && Array.isArray(o.facts)) return o; } catch { /* try next provider */ }
    } catch { clearTimeout(timer); }
  }
  return null;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function run() {
  if (await aiKilled()) return json({ ok: true, skipped: "ai_killed" });
  const db = admin();
  const since = new Date(Date.now() - LOOKBACK_H * 3600_000).toISOString();

  // Active users = anyone (not Blak) who posted or commented in the window.
  const [{ data: pa }, { data: ca }] = await Promise.all([
    db.from("nexus_posts").select("author_user_id").eq("is_soft_hidden", false).neq("author_user_id", BLAK_UID).gte("created_at", since),
    db.from("nexus_comments").select("author_user_id").eq("is_soft_hidden", false).neq("author_user_id", BLAK_UID).gte("created_at", since),
  ]);
  const users = [...new Set([...(pa || []), ...(ca || [])].map((r: any) => r.author_user_id).filter(Boolean))].slice(0, MAX_USERS);
  let processed = 0, factsWritten = 0;

  for (const uid of users) {
    try {
      const [{ data: posts }, { data: comments }] = await Promise.all([
        db.from("nexus_posts").select("title,body").eq("author_user_id", uid).eq("is_soft_hidden", false).gte("created_at", since).order("created_at", { ascending: false }).limit(40),
        db.from("nexus_comments").select("body").eq("author_user_id", uid).eq("is_soft_hidden", false).gte("created_at", since).order("created_at", { ascending: false }).limit(40),
      ]);
      const lines: string[] = [];
      for (const p of posts || []) { const t = [p.title, p.body].filter(Boolean).join(" — "); if (t) lines.push("• " + t); }
      for (const c of comments || []) { if (c.body) lines.push("↳ " + c.body); }
      const text = lines.join("\n").slice(0, MAX_CHARS).trim();
      if (text.length < 20) continue;   // not enough to learn from

      const out = await llmJson(text);
      const facts = Array.isArray(out?.facts) ? out.facts : [];
      processed++;
      const valid = facts.filter((f: any) => f && typeof f.value === "string" && f.value.trim() && f.key);
      for (const f of valid.slice(0, 5)) {
        const key = String(f.key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
        if (!key) continue;
        // Nexus learns INTERESTS (public-feed lane) — never the sensitive 'inner' lane.
        const area = ["tastes", "world", "goals", "people", "identity"].includes(String(f.area)) ? String(f.area) : "tastes";
        await db.rpc("knowledge_upsert", {
          p_user: uid, p_area: area, p_key: "nexus:" + key,
          p_label: String(f.value).slice(0, 60), p_value: String(f.value).slice(0, 300),
          p_source: "nexus", p_sensitive: false, p_confidence: 0.55, p_evidence: "Nexus posts/comments",
        });
        factsWritten++;
      }
    } catch { /* skip this user; never fail the whole run */ }
  }
  return json({ ok: true, users: users.length, processed, factsWritten });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("NEXUS_BLAK_CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
  try { return await run(); }
  catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }, 500); }
});
