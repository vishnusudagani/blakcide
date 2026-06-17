-- Blak on WhatsApp — channel store + identity link for the shared brain.
--
-- Blaksyd is master data; WhatsApp is one channel to the SAME Blak brain.
-- These tables hold the raw 1:1 conversation history that the existing vault
-- pipeline (symp_session_summaries / symp_daily_analyses / symp_persona_facts)
-- distills from. They are written by the WhatsApp Edge Function with the
-- SERVICE-ROLE key (bypasses RLS); the Blaksyd app reads them with the user's
-- JWT via owner-read policies once the phone is linked to an account.
--
-- Identity model: a WhatsApp user is keyed by their phone (wa_id) and may have
-- NO app account yet (shadow row, user_id IS NULL). On app login we match the
-- account's phone to wa_id and backfill user_id everywhere — that is what makes
-- "download app -> see all my chats, categorised" work.
--
-- Run in Supabase SQL editor or via `supabase db push`.

begin;

-- ── 1. Identity — phone <-> Blaksyd account ────────────────────────────────
create table if not exists public.blak_identities (
    id            uuid primary key default gen_random_uuid(),
    -- E.164 digits, no '+' (e.g. '917702063434'). One row per WhatsApp number.
    wa_id         text not null unique,
    -- NULL until the user installs the app and logs in (shadow profile).
    user_id       uuid references auth.users(id) on delete cascade,
    display_name  text,                       -- WhatsApp profile name from webhook
    -- Free-form opt-out / preference flags. 'opted_out' here => never send.
    flags         jsonb not null default '{}'::jsonb,
    linked_at     timestamptz,                -- when wa_id was merged to user_id
    link_method   text check (link_method in ('phone_match','otp','manual')),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_blak_identities_user on public.blak_identities (user_id);

-- ── 2. Conversations — categorised threads for the app view ────────────────
create table if not exists public.blak_conversations (
    id                   uuid primary key default gen_random_uuid(),
    identity_id          uuid not null references public.blak_identities(id) on delete cascade,
    -- Denormalised from identity for fast owner-scoped app reads. Backfilled on link.
    user_id              uuid references auth.users(id) on delete cascade,
    channel              text not null default 'whatsapp'
                            check (channel in ('whatsapp','app','voice')),
    title                text,                  -- auto-generated short title
    -- Primary bucket for the app's categorised view; `categories` allows multi-label.
    category             text,
    categories           jsonb not null default '[]'::jsonb,
    summary              text,                  -- rolling summary used for context assembly
    -- THE 24h-window anchor. Outbound (incl. proactive CRON) is allowed only
    -- while now() - last_user_inbound_at < 24h. Never send paid templates by default.
    last_user_inbound_at timestamptz,
    last_message_at      timestamptz,
    message_count        integer not null default 0,
    started_at           timestamptz not null default now(),
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);
create index if not exists idx_blak_conv_user_recent
    on public.blak_conversations (user_id, last_message_at desc);
create index if not exists idx_blak_conv_identity
    on public.blak_conversations (identity_id, last_message_at desc);
create index if not exists idx_blak_conv_category
    on public.blak_conversations (user_id, category);
create index if not exists idx_blak_conv_window
    on public.blak_conversations (last_user_inbound_at);

-- ── 3. Messages — raw 1:1 history ──────────────────────────────────────────
create table if not exists public.blak_messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.blak_conversations(id) on delete cascade,
    identity_id     uuid not null references public.blak_identities(id) on delete cascade,
    user_id         uuid references auth.users(id) on delete cascade,  -- denormalised, backfilled on link
    channel         text not null default 'whatsapp'
                       check (channel in ('whatsapp','app','voice')),
    role            text not null check (role in ('user','assistant','system')),
    content         text not null default '',
    -- Meta's wamid.* — idempotency key. Meta RETRIES webhooks; this unique
    -- constraint makes double-delivery a no-op (ON CONFLICT DO NOTHING).
    wa_message_id   text unique,
    direction       text check (direction in ('inbound','outbound')),
    -- Detected language lane, matches symp_vibe_state.language_lane vocabulary.
    lang            text check (lang in ('te','hi','en','romanized-te','romanized-hi')),
    media_type      text,                      -- text/image/audio/document/sticker/...
    media_url       text,
    status          text not null default 'received'
                       check (status in ('received','queued','sent','delivered','read','failed')),
    error           text,
    meta            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);
create index if not exists idx_blak_msg_conv on public.blak_messages (conversation_id, created_at);
create index if not exists idx_blak_msg_user on public.blak_messages (user_id, created_at desc);

-- ── 4. Link function — merge a shadow phone into an app account ─────────────
-- Called (service-role) when the user logs into the app and we match their
-- verified phone to an existing wa_id. Backfills user_id across the channel
-- store atomically so the app immediately sees the full categorised history.
create or replace function public.blak_link_identity(p_wa_id text, p_user_id uuid)
returns public.blak_identities
language plpgsql
security definer
set search_path = public
as $$
declare
    v_identity public.blak_identities;
begin
    update public.blak_identities
       set user_id     = p_user_id,
           linked_at   = now(),
           link_method = coalesce(link_method, 'phone_match'),
           updated_at  = now()
     where wa_id = p_wa_id
    returning * into v_identity;

    if v_identity.id is null then
        raise exception 'no blak_identity for wa_id %', p_wa_id;
    end if;

    update public.blak_conversations
       set user_id = p_user_id, updated_at = now()
     where identity_id = v_identity.id and user_id is distinct from p_user_id;

    update public.blak_messages
       set user_id = p_user_id
     where identity_id = v_identity.id and user_id is distinct from p_user_id;

    return v_identity;
end;
$$;

-- ── 5. updated_at touch triggers ───────────────────────────────────────────
-- Reuse symp_touch_updated_at (CREATE OR REPLACE in the unified-soul migration
-- guarantees it exists in this project).
drop trigger if exists trg_blak_identities_touch on public.blak_identities;
create trigger trg_blak_identities_touch
    before update on public.blak_identities
    for each row execute function public.symp_touch_updated_at();

drop trigger if exists trg_blak_conversations_touch on public.blak_conversations;
create trigger trg_blak_conversations_touch
    before update on public.blak_conversations
    for each row execute function public.symp_touch_updated_at();

-- ── 6. RLS — service-role writes; owner reads once linked ──────────────────
-- Enabling RLS with only SELECT policies means: anon/authenticated can read
-- ONLY their own linked rows; all writes go through the service-role Edge
-- Function (which bypasses RLS). Shadow rows (user_id IS NULL) are invisible to
-- every browser JWT until linked — exactly what we want.
alter table public.blak_identities    enable row level security;
alter table public.blak_conversations enable row level security;
alter table public.blak_messages      enable row level security;

drop policy if exists blak_identities_owner_read on public.blak_identities;
create policy blak_identities_owner_read on public.blak_identities
    for select using (auth.uid() = user_id);

drop policy if exists blak_conversations_owner_read on public.blak_conversations;
create policy blak_conversations_owner_read on public.blak_conversations
    for select using (auth.uid() = user_id);

drop policy if exists blak_messages_owner_read on public.blak_messages;
create policy blak_messages_owner_read on public.blak_messages
    for select using (auth.uid() = user_id);

commit;
