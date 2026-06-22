-- Persona sharing (invite-based, in-app). An owner mints a share code/link for one
-- of THEIR personas; anyone they send it to (a logged-in Blaksyd user) can then chat
-- with that persona as a GUEST. The chat backend verifies the code via service role.
create table if not exists public.persona_shares (
  id          uuid primary key default gen_random_uuid(),
  persona_id  uuid not null references public.fantasy_personas(id) on delete cascade,
  owner_id    uuid not null references auth.users(id)              on delete cascade,
  code        text not null unique,
  reveal      text not null default 'persona_only',  -- 'persona_only' | 'with_profile' (v1: always persona_only)
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.persona_shares enable row level security;

-- Owner can list/revoke their own shares. INSERT additionally requires that the
-- persona being shared actually belongs to the creator — so you can't mint a share
-- for someone else's persona. Guests never read this table (the backend verifies the
-- code with the service role, which bypasses RLS).
drop policy if exists "owner manages shares" on public.persona_shares;
create policy "owner manages shares" on public.persona_shares
  for all
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.fantasy_personas fp where fp.id = persona_id and fp.user_id = auth.uid())
  );
