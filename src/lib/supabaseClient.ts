// Browser-safe Supabase client for auth (passwordless email, Google OAuth,
// WhatsApp/phone OTP). Uses ONLY the public anon key — which is designed to be
// exposed in client code; Row-Level Security protects your data. The private
// service-role key is never imported here and must never reach the browser.
//
// Set these as PUBLIC_ env vars (Netlify + local .env) so Astro ships them to the
// client. They are the same project as your existing SUPABASE_URL — so accounts
// created here are real, unified users:
//   PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
//   PUBLIC_SUPABASE_ANON_KEY=<your anon/publishable key>
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const anon = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anon);

// Null until the public env vars exist — the auth UI degrades gracefully
// (falls back to waitlist capture) rather than throwing during build/runtime.
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url as string, anon as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // completes the Google OAuth / magic-link redirect
        flowType: 'pkce',
      },
    })
  : null;
