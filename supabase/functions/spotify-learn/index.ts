// spotify-learn — pull the user's top artists / tracks / genres from Spotify and
// write them as 'tastes' facts (symp_knowledge_facts) so Blak knows their music
// and can DJ from it. Auth'd. Mirrors gmail-receipts' fact-write shape.

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
  if (!clientId || !clientSecret) return json({ error: "not_configured" }, 500);

  const db = admin();
  const token = await getSpotifyToken(db, user.id, clientId, clientSecret).catch(() => null);
  if (!token) return json({ error: "not_connected" }, 400);

  const auth = { Authorization: `Bearer ${token}` };

  let artists: string[] = [];
  const genreSet = new Set<string>();
  try {
    const r = await fetch("https://api.spotify.com/v1/me/top/artists?limit=15&time_range=medium_term", { headers: auth });
    if (r.ok) {
      const j = await r.json() as any;
      for (const a of (j.items || [])) {
        if (a?.name) artists.push(a.name);
        for (const g of (a?.genres || [])) genreSet.add(g);
      }
    }
  } catch (_) { /* ignore */ }

  let tracks: string[] = [];
  try {
    const r = await fetch("https://api.spotify.com/v1/me/top/tracks?limit=15&time_range=medium_term", { headers: auth });
    if (r.ok) {
      const j = await r.json() as any;
      for (const t of (j.items || [])) {
        if (t?.name) tracks.push(`${t.name} — ${(t.artists || []).map((a: any) => a.name).join(", ")}`);
      }
    }
  } catch (_) { /* ignore */ }

  const genres = [...genreSet];
  const now = new Date().toISOString();
  const facts = [
    { key: "music_top_artists", label: "Top artists", value: artists.slice(0, 10).join(", ") },
    { key: "music_genres",      label: "Music genres", value: genres.slice(0, 8).join(", ") },
    { key: "music_top_tracks",  label: "On repeat", value: tracks.slice(0, 8).join("; ") },
  ].filter((f) => f.value);

  if (facts.length) {
    const rows = facts.map((f) => ({
      user_id: user.id, area: "tastes", key: f.key, label: f.label,
      value: f.value, source: "spotify", confidence: 0.9,
      status: "active", last_seen_at: now,
    }));
    try { await db.from("symp_knowledge_facts").upsert(rows, { onConflict: "user_id,area,key" }); } catch (_) { /* ignore */ }
  }

  try {
    await db.from("symp_integrations").upsert({
      user_id: user.id, provider: "spotify", category: "music",
      status: "learning", last_sync_at: now,
    }, { onConflict: "user_id,provider" });
  } catch (_) { /* ignore */ }

  return json({ artists: artists.length, tracks: tracks.length, genres: genres.length });
});
