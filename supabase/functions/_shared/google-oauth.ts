// Google OAuth helpers for the Gmail connect flow (server-side authorization
// code flow). The browser never sees the client secret or the tokens.
//
// Identity across the redirect is carried in an HMAC-signed `state` (user_id +
// expiry), so Google's tokenless redirect to the callback can still be trusted.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface TokenResp {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(msg))));
}

/** state = `${userId}.${exp}.${sig}` — userId is a UUID (no dots), so it splits cleanly. */
export async function signState(userId: string, secret: string, ttlSec = 600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyState(state: string, secret: string): Promise<string | null> {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  if (sig !== (await hmac(secret, `${userId}.${expStr}`))) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return userId;
}

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // get a refresh token
    prompt: "consent", // force a refresh token on every connect
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(
  code: string, redirectUri: string, clientId: string, clientSecret: string,
): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResp;
}

export async function refreshAccessToken(
  refreshToken: string, clientId: string, clientSecret: string,
): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: clientId,
      client_secret: clientSecret, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh ${res.status}`);
  return (await res.json()) as TokenResp;
}

export async function getGmailAddress(accessToken: string): Promise<string | null> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { emailAddress?: string };
  return j.emailAddress ?? null;
}

/** Return a valid Gmail access token for a user, refreshing if needed. Null if
 * the user hasn't connected Gmail. */
export async function getGmailToken(
  db: SupabaseClient, userId: string, clientId: string, clientSecret: string,
): Promise<string | null> {
  const { data } = await db
    .from("symp_oauth_tokens")
    .select("refresh_token,access_token,expires_at")
    .eq("user_id", userId).eq("provider", "gmail")
    .maybeSingle();
  if (!data) return null;
  const exp = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  if (data.access_token && exp > Date.now() + 60_000) return data.access_token;
  if (!data.refresh_token) return data.access_token ?? null;
  const tok = await refreshAccessToken(data.refresh_token, clientId, clientSecret);
  if (!tok.access_token) return null;
  await db.from("symp_oauth_tokens").update({
    access_token: tok.access_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
  }).eq("user_id", userId).eq("provider", "gmail");
  return tok.access_token;
}
