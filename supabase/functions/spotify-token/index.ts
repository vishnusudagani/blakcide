// spotify-token — returns the caller's fresh Spotify access token for the Web
// Playback SDK (getOAuthToken) and direct Web API playback calls. Auth'd (user JWT).
// This is the USER's own short-lived token, scoped to their account — the standard
// Web Playback SDK pattern (the token must live client-side to stream). Returns
// { connected:false } if they haven't connected Spotify.

import { admin, getUserFromRequest } from "../_shared/supabase.ts";
import { getSpotifyToken } from "../_shared/spotify-oauth.ts";

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

  const clientId = Deno.env.get("SPOTIFY_OAUTH_CLIENT_ID") || Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_OAUTH_CLIENT_SECRET") || Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return json({ connected: false, reason: "not_configured" });

  const token = await getSpotifyToken(admin(), user.id, clientId, clientSecret).catch(() => null);
  if (!token) return json({ connected: false });
  return json({ connected: true, access_token: token });
});
