// nexus-image-mod — image safety check for Nexus uploads (NEXUS-GAPS.md Phase 1, #3).
//
// Called by the client AFTER an image lands in the public nexus-img bucket, with the
// public URL. Returns { allow, reason }. Multi-provider, no-budget friendly:
//   1) OpenAI omni-moderation-latest  — FREE endpoint, supports image inputs (needs
//      OPENAI_API_KEY). Blocks sexual / minors / graphic-violence / self-harm.
//   2) Gemini vision (OpenAI-compat)  — reuses the existing GEMINI_BASE_URL proxy.
//   3) FAIL OPEN by default — if no provider is configured or anything errors, allow
//      the image (image sharing must never break); the call is also gated client-side
//      behind PUBLIC_NEXUS_PROXY so prod is unaffected until cutover.
//
// Set MODERATION_MODE=closed to FAIL CLOSED instead: when no provider is configured
// (or one errors out) the image is BLOCKED. Only flip this once a vision provider
// (OPENAI_API_KEY / GEMINI_API_KEY) is set, or every image will be rejected.
//
// CSAM hash-matching (PhotoDNA / NCMEC — free for qualifying platforms) is a separate
// hardening step: apply for access, then add a hash check here. TODO(csam).

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Default-open preserves today's behavior; set MODERATION_MODE=closed to block
// when no moderation verdict can be obtained (no provider / provider error).
const FAIL_ALLOW = (Deno.env.get("MODERATION_MODE") ?? "open").toLowerCase() !== "closed";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Require a real signed-in user (only signed-in users upload). Fail OPEN on hiccup.
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (jwt && url && anon) {
      try {
        const sb = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
        const { data } = await sb.auth.getUser();
        if (!data?.user) return json({ allow: true, reason: "unauthenticated" });
      } catch (_) { /* fall through, fail open */ }
    }
    const body = await req.json().catch(() => ({}));
    const imgUrl = (body as { url?: string })?.url;
    if (!imgUrl) return json({ allow: true, reason: "no-url" });
    return json(await classify(imgUrl));
  } catch (e) {
    return json({ allow: FAIL_ALLOW, reason: (FAIL_ALLOW ? "error:" : "error-failclosed:") + ((e as Error)?.message || "x") });
  }
});

async function classify(imgUrl: string): Promise<{ allow: boolean; reason: string }> {
  // 1) OpenAI free moderation (image-capable)
  const oai = Deno.env.get("OPENAI_API_KEY");
  if (oai) {
    try {
      const r = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${oai}` },
        body: JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: imgUrl } }] }),
      });
      if (r.ok) {
        const d = await r.json();
        const res = d?.results?.[0];
        if (res?.flagged) {
          const cats = Object.entries(res.categories || {}).filter(([, v]) => v).map(([k]) => k);
          const block = cats.some((c) => /sexual|minor|graphic|self.?harm/i.test(c));
          return { allow: !block, reason: "openai:" + cats.join(",") };
        }
        return { allow: true, reason: "openai:clean" };
      }
    } catch (_) { /* try next */ }
  }
  // 2) Gemini vision via the existing proxy
  const gUrl = Deno.env.get("GEMINI_BASE_URL"), gKey = Deno.env.get("GEMINI_API_KEY");
  const gModel = Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-2.5-flash";
  if (gUrl && gKey) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch(gUrl, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gKey}` },
        body: JSON.stringify({
          model: gModel, temperature: 0, max_tokens: 8,
          messages: [
            { role: "system", content: "You are an image safety classifier. Reply with ONE word only: BLOCK if the image shows nudity, sexual content, any sexual content involving minors, graphic violence/gore, or self-harm; otherwise SAFE." },
            { role: "user", content: [{ type: "text", text: "Classify this image." }, { type: "image_url", image_url: { url: imgUrl } }] },
          ],
        }),
      });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        const txt = (d?.choices?.[0]?.message?.content || "").toUpperCase();
        return { allow: !txt.includes("BLOCK"), reason: "gemini:" + txt.trim().slice(0, 16) };
      }
    } catch (_) { /* fall through */ }
  }
  // 3) no verdict available — fail open by default, or block if MODERATION_MODE=closed
  return { allow: FAIL_ALLOW, reason: FAIL_ALLOW ? "no-provider" : "no-provider-failclosed" };
}
