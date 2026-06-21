-- Per-persona memory: each user's evolving memory with ONE fantasy persona — the
-- character's own memory of that person and their shared history. Distinct from the
-- global profile (profiles.user_memory). Written by blak-learn-background (service
-- role, off the request path); read by the persona chat/call system-prompt builder.

create table if not exists public.symp_persona_memory (
    user_id    uuid not null references auth.users(id)              on delete cascade,
    persona_id uuid not null references public.fantasy_personas(id) on delete cascade,
    memory     text not null default '',
    updated_at timestamptz not null default now(),
    primary key (user_id, persona_id)
);

alter table public.symp_persona_memory enable row level security;

-- Owner can read/manage their own persona memories; the background writer uses the
-- service role, which bypasses RLS.
drop policy if exists "own persona memory" on public.symp_persona_memory;
create policy "own persona memory"
    on public.symp_persona_memory
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
