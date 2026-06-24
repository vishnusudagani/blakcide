// spotify-oauth-callback — Spotify redirects the browser here with ?code & ?state.
// No JWT on the redirect, so identity comes from the signed state. We exchange the
// code for tokens, store them server-side, mark the integration connected, then
// bounce back to the account page. Mirrors gmail-oauth-callback.
//
// Deploy with verify_jwt = false (public): Spotify's redirect carries no JWT.

import { admin } from "../_shared/supabase.ts";
import { exchangeCode, getSpotifyProfile, verifyState } from "../_shared/spotify-oauth.ts";

const SITE = "https://blaksyd.com";
const back = (status: string) =>
  new Response(null, { status: 302, headers: { Location: `${SITE}/beta/account?spotify=${status}` } });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) return back("error");

  const stateSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("SPOTIFY_OAUTH_CLIENT_ID") || Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_OAUTH_CLIENT_SECRET") || Deno.env.get("SPOTIFY_CLIENT_SECRET");
  const supaUrl = Deno.env.get("SUPABASE_URL");
  if (!stateSecret || !clientId || !clientSecret || !supaUrl) return back("error");

  const userId = await verifyState(state, stateSecret);
  if (!userId) return back("error");

  try {
    const tok = await exchangeCode(
      code, `${supaUrl}/functions/v1/spotify-oauth-callback`, clientId, clientSecret,
    );
    const name = tok.access_token ? await getSpotifyProfile(tok.access_token).catch(() => null) : null;
    const db = admin();

    await db.from("symp_oauth_tokens").upsert({
      user_id: userId, provider: "spotify",
      refresh_token: tok.refresh_token ?? null,
      access_token: tok.access_token ?? null,
      expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      scope: tok.scope ?? null,
    }, { onConflict: "user_id,provider" });

    await db.from("symp_integrations").upsert({
      user_id: userId, provider: "spotify", category: "music",
      status: "connected", display_name: name,
    }, { onConflict: "user_id,provider" });

    return back("connected");
  } catch (_e) {
    return back("error");
  }
});
