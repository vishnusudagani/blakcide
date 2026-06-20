// minit-learn — Learning loop Phase 3 (backend). NIGHTLY. Minit conversations are
// never stored, so the learning input is the seeker's OWN optional post-session
// reflections (mood + a short note they CHOSE to share). For each user with a
// recent reflection, distil a FEW abstracted, gentle "what you're navigating"
// themes — never quoting, never clinical, never naming anyone. Marked SENSITIVE:
// these feed Blak's PRIVATE context only, never the public Nexus feed (lane
// separation). source 'minit'. Fails CLOSED on the shared cron secret.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const MAX_USERS = 25;
const LOOKBACK_H = 26;        // users with a NEW reflection since the last run
const HISTORY_DAYS = 7;       // synthesise from their recent reflection history
const MOODS: Record<string, string> = { great: "good", okay: "okay", low: "low", anxious: "anxious", angry: "frustrated" };

const SYSTEM =
  "You gently keep a private, compassionate sense of what someone is navigating in life, " +
  "drawn ONLY from their own brief reflections after talking with a listener. " +
  "Distil a FEW abstracted, present-tense themes — what they seem to be going through, gentle emotional patterns. " +
  "Output ONLY JSON: {\"facts\":[{\"area\":\"...\",\"key\":\"...\",\"value\":\"...\"}]}. " +
  "area is 'inner' (what they're navigating/feeling), 'people' (a relationship — ROLE only, e.g. 'a close friend'), or 'goals'. " +
  "key = a short stable lowercase slug. value = a warm, plain, ABSTRACTED statement ('navigating a heavy stretch at work', 'leaning on a close friend lately'). " +
  "RULES: NEVER quote their words; NEVER use clinical/diagnostic/medical/mental-health labels; NEVER name anyone (roles only); stay gentle and non-judgmental; " +
  "these are sensitive, so be conservative — 0 to 3 items, only clear ones, an empty list is best when unsure.";

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
        body: JSON.stringify({ model: p.model, messages, temperature: 0.3, max_tokens: 400, response_format: { type: "json_object" } }),
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j = await res.json();
      const txt = (j?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json\s*|\s*```$/g, "");
      try { return JSON.parse(txt); } catch { /* next provider */ }
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
  const recent = new Date(Date.now() - LOOKBACK_H * 3600_000).toISOString();
  const history = new Date(Date.now() - HISTORY_DAYS * 86400_000).toISOString();

  const { data: fresh } = await db.from("minit_reflections").select("user_id").gte("created_at", recent);
  const users = [...new Set((fresh || []).map((r: any) => r.user_id).filter(Boolean))].slice(0, MAX_USERS);
  let processed = 0, factsWritten = 0;

  for (const uid of users) {
    try {
      const { data: refs } = await db.from("minit_reflections")
        .select("mood,note,created_at").eq("user_id", uid).gte("created_at", history)
        .order("created_at", { ascending: false }).limit(8);
      const lines: string[] = [];
      for (const r of refs || []) {
        const parts: string[] = [];
        if (r.mood) parts.push("felt " + (MOODS[r.mood] || r.mood));
        if (r.note && String(r.note).trim()) parts.push(String(r.note).trim());
        if (parts.length) lines.push("• " + parts.join(" — "));
      }
      const text = lines.join("\n").slice(0, 4000).trim();
      if (text.length < 8) continue;
      processed++;

      const out = await llmJson("Recent reflections after talking with a listener:\n" + text);
      const facts = Array.isArray(out?.facts) ? out.facts : [];
      for (const f of facts.slice(0, 3)) {
        if (!f || typeof f.value !== "string" || !f.value.trim()) continue;
        const key = String(f.key || f.value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
        if (!key) continue;
        const area = ["inner", "people", "goals"].includes(String(f.area)) ? String(f.area) : "inner";
        await db.rpc("knowledge_upsert", {
          p_user: uid, p_area: area, p_key: "minit:" + key,
          p_label: String(f.value).slice(0, 60), p_value: String(f.value).slice(0, 300),
          p_source: "minit", p_sensitive: true, p_confidence: 0.5, p_evidence: "Minit reflections",
        });
        factsWritten++;
      }
    } catch { /* skip this user */ }
  }
  return json({ ok: true, users: users.length, processed, factsWritten });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("NEXUS_BLAK_CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
  try { return await run(); }
  catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }, 500); }
});
