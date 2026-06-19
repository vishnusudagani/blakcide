-- Fantasy Personas: user-created AI characters, each with its own chat.
create table if not exists public.fantasy_personas (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  name               text not null,
  tagline            text,
  purpose            text,                       -- ai_friend | study_buddy | hype | coach | roleplay | custom
  avatar             jsonb,                      -- DiceBear config { style, seed, options } (or { url })
  backstory          text,
  traits             text[] not null default '{}',   -- personality tags
  voice_tone         text,                       -- written tone/style instructions
  voice              text,                       -- Gemini Live voice name (e.g. Aoede)
  languages          text[] not null default '{}',
  build_profile_from boolean not null default true,
  can_use_profile    boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.fantasy_personas enable row level security;

create policy "fantasy_personas_select_own" on public.fantasy_personas
  for select to authenticated using (auth.uid() = user_id);
create policy "fantasy_personas_insert_own" on public.fantasy_personas
  for insert to authenticated with check (auth.uid() = user_id);
create policy "fantasy_personas_update_own" on public.fantasy_personas
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fantasy_personas_delete_own" on public.fantasy_personas
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists fantasy_personas_user_idx on public.fantasy_personas (user_id, created_at desc);

-- Link a chat to a fantasy persona (null = a normal Blak chat). Cascade so deleting
-- a persona cleans up its conversations.
alter table public.chats add column if not exists persona_id uuid references public.fantasy_personas(id) on delete cascade;
create index if not exists chats_persona_id_idx on public.chats (persona_id) where persona_id is not null;
