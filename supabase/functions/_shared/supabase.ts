// Service-role Supabase client for the WhatsApp Edge Functions.
//
// The channel store and brain tables are protected by RLS with NO write
// policies — every write here uses the SERVICE-ROLE key, which bypasses RLS.
// This key is server-only; it never reaches a browser. Keep it in Edge
// Function secrets (`supabase secrets set`), never in client code or git.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

/** Lazily build the singleton service-role client from Edge secrets. */
export function admin(): SupabaseClient {
  if (cached) return cached;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in Edge secrets",
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Resolve the calling user from a request's Authorization header — the canonical
 * edge-function pattern: an ANON-keyed client scoped to the user's JWT, then
 * getUser(). More reliable than service-role getUser(jwt). Logs the reason on
 * failure so auth problems are debuggable. Returns null if unauthenticated.
 */
export async function getUserFromRequest(
  req: Request,
): Promise<{ id: string; email: string | null } | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) {
    console.error("auth: missing Authorization header");
    return null;
  }
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) {
    console.error("auth: missing SUPABASE_URL / SUPABASE_ANON_KEY");
    return null;
  }
  const client = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) {
    let role = "?";
    try {
      role = JSON.parse(atob((authHeader.replace(/^Bearer\s+/i, "").split(".")[1] || ""))).role || "?";
    } catch { role = "decode_err"; }
    console.error("auth: getUser failed:", error?.message || "no user", "| token role:", role);
    return null;
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Emergency kill switch — reuses the existing global_settings row that the
 * website's chat-stream already honors. When enabled, the webhook stays silent
 * (no model call, no token spend, no outbound message). Cached briefly so we
 * don't hit the DB on every inbound.
 */
const KILL_TTL_MS = 30_000;
let killCache = { value: false, at: 0 };

export async function aiKilled(): Promise<boolean> {
  const now = Date.now();
  if (now - killCache.at < KILL_TTL_MS) return killCache.value;
  try {
    const { data } = await admin()
      .from("global_settings")
      .select("value")
      .eq("key", "ai_voice_killswitch")
      .maybeSingle();
    const enabled = !!(data?.value as { enabled?: boolean } | null)?.enabled;
    killCache = { value: enabled, at: now };
    return enabled;
  } catch {
    return false; // fail open: a settings hiccup shouldn't mute Blak
  }
}
