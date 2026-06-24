// spotify-now — read the user's now-playing + top artists for the Blak music panel.
// Auth'd (user JWT). Returns { connected:false } gracefully if Spotify isn't
// connected or configured, so the UI degrades cleanly.

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

  const auth = { Authorization: `Bearer ${token}` };

  let now: unknown = null;
  try {
    const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", { headers: auth });
    if (r.status === 200) {
      const j = await r.json() as any;
      if (j && j.item) {
        now = {
          name: j.item.name,
          artist: (j.item.artists || []).map((a: any) => a.name).join(", "),
          albumArt: j.item.album?.images?.[1]?.url || j.item.album?.images?.[0]?.url || "",
          url: j.item.external_urls?.spotify || "",
          isPlaying: !!j.is_playing,
        };
      }
    }
  } catch (_) { /* ignore */ }

  let topArtists: string[] = [];
  try {
    const r = await fetch("https://api.spotify.com/v1/me/top/artists?limit=5&time_range=medium_term", { headers: auth });
    if (r.ok) { const j = await r.json() as any; topArtists = (j.items || []).map((a: any) => a.name); }
  } catch (_) { /* ignore */ }

  return json({ connected: true, now_playing: now, top_artists: topArtists });
});
