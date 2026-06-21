-- Server-only OAuth token store. Holds the Gmail (and future provider) refresh +
-- access tokens used by edge functions to read receipts on the user's behalf.
--
-- SECURITY: RLS is ON with NO policies, so neither the anon nor the authenticated
-- (browser) role can read or write ANY row — only the service-role key (edge
-- functions) bypasses RLS. Tokens are secrets and must never reach the client.

create table if not exists public.symp_oauth_tokens (
    user_id       uuid not null references auth.users(id) on delete cascade,
    provider      text not null,                 -- 'gmail' (more later)
    refresh_token text,                           -- long-lived; used to mint access tokens
    access_token  text,                           -- short-lived cache
    expires_at    timestamptz,                    -- access_token expiry
    scope         text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    primary key (user_id, provider)
);

alter table public.symp_oauth_tokens enable row level security;
-- Intentionally NO policies: service-role only.

drop trigger if exists trg_oauth_tokens_touch on public.symp_oauth_tokens;
create trigger trg_oauth_tokens_touch
    before update on public.symp_oauth_tokens
    for each row execute function symp_touch_updated_at();
