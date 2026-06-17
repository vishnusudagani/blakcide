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
