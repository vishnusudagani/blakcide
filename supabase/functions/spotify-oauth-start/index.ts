// spotify-oauth-start — begins the Spotify connect flow. Called from the browser
// via supabase.functions.invoke('spotify-oauth-start') (sends the user's JWT).
// Verifies the user, signs a short-lived state, returns the Spotify authorize URL.
// Mirrors gmail-oauth-start.

import { getUserFromRequest } from "../_shared/supabase.ts";
import { buildAuthorizeUrl, signState } from "../_shared/spotify-oauth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const user = await getUserFromRequest(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  // Reuse the existing Spotify app's id/secret if dedicated OAuth ones aren't set.
  const clientId = Deno.env.get("SPOTIFY_OAUTH_CLIENT_ID") || Deno.env.get("SPOTIFY_CLIENT_ID");
  const stateSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supaUrl = Deno.env.get("SUPABASE_URL");
  if (!clientId || !stateSecret || !supaUrl) {
    console.error("spotify-oauth-start: missing env", { clientId: !!clientId, stateSecret: !!stateSecret, supaUrl: !!supaUrl });
    return json({ error: "not_configured" }, 500);
  }

  const state = await signState(user.id, stateSecret);
  const url = buildAuthorizeUrl({
    clientId,
    redirectUri: `${supaUrl}/functions/v1/spotify-oauth-callback`,
    state,
  });
  return json({ url });
});
