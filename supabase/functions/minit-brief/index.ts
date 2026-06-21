// minit-brief — Phase 1 of the Minit 50-gap buildout. JWT-gated (the seeker
// calls it for THEMSELVES). Generates Blak's pre-session co-pilot brief: an
// abstracted "shape, not content" summary the seeker reviews & approves before
// connecting to a listener. Pulls the caller's own learning-loop facts + recent
// reflections + whether they've talked before, and distils:
//   { shape, topics[], nogo[], helps[], continuity }
// It NEVER stores — the seeker approves/edits client-side, then writes the row
// (RLS owner-insert). Sensitive facts are folded into "shape", never quoted.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const MOODS: Record<string, string> = { great: "good", okay: "okay", low: "low", anxious: "anxious", angry: "frustrated" };

const SYSTEM =
  "You are Blak, gently briefing a trained human listener BEFORE they talk with someone you know well. " +
  "Give them the SHAPE of the conversation, never the content — context, not a transcript. Warm, plain, human. " +
  "Output ONLY JSON: {\"shape\":\"...\",\"topics\":[\"...\"],\"nogo\":[\"...\"],\"helps\":[\"...\"],\"continuity\":\"...\"}. " +
  "shape = one or two sentences on how they're arriving (their emotional weather), abstracted. " +
  "topics = a few things they may want to get into. nogo = anything to steer clear of right now (often empty). " +
  "helps = what tends to help them (e.g. 'space before advice', 'gentle directness', 'just being heard'). " +
  "continuity = one line ONLY if they've talked before, else empty. " +
  "RULES: never quote them; never use clinical/diagnostic/medical/mental-health labels; never name anyone (roles only); " +
  "fold anything sensitive into 'shape' as a gentle abstraction; be conservative — empty fields are fine when unsure.";

function providers() {
  return [
    { endpoint: Deno.env.get("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-2.5-flash", apiKey: Deno.env.get("GEMINI_API_KEY") },
    { endpoint: "https://api.together.xyz/v1/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct-Turbo", apiKey: Deno.env.get("TOGETHER_API_KEY") },
    { endpoint: "https://api.fireworks.ai/inference/v1/chat/completions", model: "accounts/fireworks/models/qwen2p5-72b-instruct", apiKey: Deno.env.get("FIREWORKS_API_KEY") },
    { endpoint: "https://api.deepinfra.com/v1/openai/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct", apiKey: Deno.env.get("DEEPINFRA_API_KEY") },
    { endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", apiKey: Deno.env.get("GROQ_API_KEY") },
  ].filter((p) => !!p.apiKey);
}

async function llmBrief(userText: string): Promise<Record<string, unknown> | null> {
  const ps = providers();
  if (!ps.length) return null;
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: userText }];
  for (const p of ps) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(p.endpoint, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model, messages, temperature: 0.4, max_tokens: 400, response_format: { type: "json_object" } }),
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j = await res.json();
      const txt = (j?.choices?.[0]?.message?.content ?? "").trim().replace(/^```json\s*|\s*```$/g, "");
      try { const o = JSON.parse(txt); if (o && typeof o === "object") return o; } catch { /* next provider */ }
    } catch { clearTimeout(timer); }
  }
  return null;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
async function aiKilled(db: SupabaseClient): Promise<boolean> {
  try { const { data } = await db.from("global_settings").select("value").eq("key", "ai_voice_killswitch").maybeSingle(); return !!((data?.value as { enabled?: boolean } | null)?.enabled); } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const auth = req.headers.get("Authorization") || "";
  if (!url || !anon) return json({ ok: false, error: "misconfigured" }, 500);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401);

  // User-scoped client — RLS naturally limits every read to the caller's own rows.
  const db = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: ures } = await db.auth.getUser();
  const uid = ures?.user?.id;
  if (!uid) return json({ ok: false, error: "unauthorized" }, 401);

  if (await aiKilled(db)) return json({ ok: true, brief: { shape: "", topics: [], nogo: [], helps: [], continuity: "" }, skipped: "ai_killed" });

  let focus = "";
  try { const body = await req.json(); focus = String(body?.focus || "").slice(0, 500).trim(); } catch { /* no body */ }

  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [factsR, refsR, pastR] = await Promise.all([
    db.from("symp_knowledge_facts").select("label,key,value,sensitive,confidence,status").eq("user_id", uid).neq("status", "suppressed").order("confidence", { ascending: false }).limit(40),
    db.from("minit_reflections").select("mood,note,created_at").eq("user_id", uid).gte("created_at", since).order("created_at", { ascending: false }).limit(5),
    db.from("connect_sessions").select("id").eq("user_id", uid).eq("status", "completed").limit(1),
  ]);
  const facts = factsR.data || [];
  const interests = facts.filter((f: any) => !f.sensitive).map((f: any) => `${f.label || f.key}: ${f.value}`);
  const inner = facts.filter((f: any) => f.sensitive).map((f: any) => String(f.value));
  const moods = (refsR.data || []).map((r: any) => (r.mood ? "felt " + (MOODS[r.mood] || r.mood) : "") + (r.note ? " — " + String(r.note) : "")).filter(Boolean);
  const talkedBefore = !!(pastR.data && pastR.data.length);

  const lines: string[] = [];
  if (focus) lines.push("They said today: " + focus);
  if (moods.length) lines.push("Recent check-ins after past sessions: " + moods.join("; "));
  if (inner.length) lines.push("Things they're navigating (ABSTRACT these into 'shape', never quote): " + inner.join("; "));
  if (interests.length) lines.push("What they care about / who's in their life: " + interests.slice(0, 12).join("; "));
  lines.push("Talked with a listener before: " + (talkedBefore ? "yes" : "no"));
  const text = lines.join("\n").slice(0, 4000);

  let brief = await llmBrief(text);
  if (!brief || typeof brief !== "object") brief = { shape: "", topics: focus ? [focus] : [], nogo: [], helps: [], continuity: "" };

  const arr = (x: unknown) => Array.isArray(x) ? x.map((s) => String(s).slice(0, 120)).filter(Boolean).slice(0, 6) : [];
  const out = {
    shape: String((brief as any).shape || "").slice(0, 300),
    topics: arr((brief as any).topics),
    nogo: arr((brief as any).nogo),
    helps: arr((brief as any).helps),
    continuity: talkedBefore ? String((brief as any).continuity || "").slice(0, 200) : "",
  };
  return json({ ok: true, brief: out });
});
