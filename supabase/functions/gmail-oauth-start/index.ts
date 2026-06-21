// gmail-oauth-start — begins the Gmail connect flow. Called from the browser via
// supabase.functions.invoke('gmail-oauth-start') (which sends the user's JWT).
// Verifies the user, signs a short-lived state, and returns the Google authorize
// URL for the browser to navigate to.

import { admin } from "../_shared/supabase.ts";
import { buildAuthorizeUrl, signState } from "../_shared/google-oauth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const { data, error } = await admin().auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "unauthorized" }, 401);

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const stateSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supaUrl = Deno.env.get("SUPABASE_URL");
  if (!clientId || !stateSecret || !supaUrl) return json({ error: "not_configured" }, 500);

  const state = await signState(data.user.id, stateSecret);
  const url = buildAuthorizeUrl({
    clientId,
    redirectUri: `${supaUrl}/functions/v1/gmail-oauth-callback`,
    state,
  });
  return json({ url });
});
