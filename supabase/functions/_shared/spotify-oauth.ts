// Spotify OAuth helpers (server-side authorization-code flow). Mirrors
// google-oauth.ts — the browser never sees the client secret or the tokens.
// Identity across Spotify's tokenless redirect is carried in the same HMAC-signed
// `state` (reused from google-oauth.ts: generic userId+expiry signing).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
export { signState, verifyState } from "./google-oauth.ts";

// Scopes: top artists/tracks (taste), now-playing + recently-played (DJ context),
// profile (display name). No playback-control scope yet — that's M2 (Web Playback SDK).
const SCOPE =
  "user-top-read user-read-currently-playing user-read-recently-played user-read-private";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

interface TokenResp {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const basicAuth = (id: string, secret: string) => "Basic " + btoa(`${id}:${secret}`);

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: SCOPE,
    state: opts.state,
    show_dialog: "false",
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(
  code: string, redirectUri: string, clientId: string, clientSecret: string,
): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams({ code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new Error(`spotify token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResp;
}

export async function refreshAccessToken(
  refreshToken: string, clientId: string, clientSecret: string,
): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams({ refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`spotify token refresh ${res.status}`);
  return (await res.json()) as TokenResp;
}

export async function getSpotifyProfile(accessToken: string): Promise<string | null> {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { display_name?: string; id?: string };
  return j.display_name || j.id || null;
}

/** Return a valid Spotify access token for a user, refreshing if needed. Null if
 * the user hasn't connected Spotify. */
export async function getSpotifyToken(
  db: SupabaseClient, userId: string, clientId: string, clientSecret: string,
): Promise<string | null> {
  const { data } = await db
    .from("symp_oauth_tokens")
    .select("refresh_token,access_token,expires_at")
    .eq("user_id", userId).eq("provider", "spotify")
    .maybeSingle();
  if (!data) return null;
  const exp = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  if (data.access_token && exp > Date.now() + 60_000) return data.access_token;
  if (!data.refresh_token) return data.access_token ?? null;
  const tok = await refreshAccessToken(data.refresh_token, clientId, clientSecret);
  if (!tok.access_token) return null;
  await db.from("symp_oauth_tokens").update({
    access_token: tok.access_token,
    // Spotify often omits refresh_token on refresh — keep the existing one.
    refresh_token: tok.refresh_token ?? data.refresh_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
  }).eq("user_id", userId).eq("provider", "spotify");
  return tok.access_token;
}
