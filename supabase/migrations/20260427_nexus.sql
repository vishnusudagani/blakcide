-- ── The Blaksyd Nexus (Community Module) — foundational schema ───────────────
--
-- Design pillars (matches the Lead Social Systems Architect spec):
--
--   1. Resonance Matching — every member of every community has a stored
--      vault-embedding (pgvector). At read-time we cosine-compare the viewer
--      against post authors and surface a "Resonance Score" so users see
--      content from people whose experience rhymes with theirs.
--
--   2. Omnipresent AI Participant — there is exactly one synthetic author,
--      pinned via the `is_ai_author` flag on a real auth.users row. The AI
--      is a first-class member of every community and posts/comments through
--      the same tables, just like any other user.
--
--   3. Pop-Up Communities — `nexus_communities.is_ephemeral=true` plus
--      `expires_at` lets the TrendAnalyzer spawn time-boxed spaces around
--      detected emotional spikes (e.g., "Exam Anxiety – April 2026").
--
--   4. Impact Engagement Loop — there are NO upvotes or downvotes. The only
--      reaction primitive is `nexus_impacts` with positive-only types
--      ('felt_seen','resonated','helpful','sending_strength'). The aggregate
--      `impact_count` is denormalised on the post for fast feed sorting.
--
--   5. Extreme Escalation — every post and comment runs through a distress
--      classifier. `risk_level` and `is_soft_hidden` let the platform
--      gracefully shadow a crisis post from the public feed while triggering
--      a Human Connect Co-Pilot invite to the author.
--
-- Anonymity model:
--   Inside a community, a user's real auth.users.id is NEVER exposed to other
--   members. Each (user, community) pair gets a stable pseudonymous handle
--   in nexus_anonymous_handles. Posts/comments store the raw user_id (so RLS
--   and ownership checks work) but the API layer projects responses through
--   the handle table.
--
-- All writes from server modules go through the service role and bypass RLS.
-- The browser only ever talks to the proxy at /api/blaksyd/symp/nexus/*.

begin;

-- pgvector for resonance scoring. Idempotent — Supabase usually has it on.
create extension if not exists vector;

-- ── 1. Communities ────────────────────────────────────────────────────────
create table if not exists public.nexus_communities (
    id              uuid primary key default gen_random_uuid(),
    slug            text not null unique,
    name            text not null,
    description     text,
    -- Spawned by the TrendAnalyzer? Ephemeral communities auto-archive at
    -- expires_at. Permanent ones (e.g. evergreen "exam-anxiety") have
    -- is_ephemeral=false and expires_at=null.
    is_ephemeral    boolean not null default false,
    expires_at      timestamptz,
    -- Privacy lever. 'public' is the default; future-proofing the column
    -- now is cheaper than ALTERing a hot table later.
    visibility      text not null default 'public'
                       check (visibility in ('public','members_only')),
    -- Trend metadata (what spike spawned this community, what emotion, etc.)
    trend_signal    jsonb not null default '{}'::jsonb,
    -- AI fingerprint of the community theme — used to bias resonance and
    -- to match new vault embeddings for "you might belong here" notifications.
    theme_embedding vector(1536),
    archived_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists idx_nexus_communities_active
    on public.nexus_communities (created_at desc)
    where archived_at is null;
create index if not exists idx_nexus_communities_ephemeral
    on public.nexus_communities (expires_at)
    where is_ephemeral = true and archived_at is null;

-- ── 2. Community membership ───────────────────────────────────────────────
create table if not exists public.nexus_community_members (
    community_id  uuid not null references public.nexus_communities(id) on delete cascade,
    user_id       uuid not null references auth.users(id) on delete cascade,
    joined_at     timestamptz not null default now(),
    -- Cached snapshot at join time so the feed can compute a "why you?" line
    -- without recomputing embeddings on every request.
    join_resonance numeric(5,4),
    role          text not null default 'member'
                     check (role in ('member','moderator','ai')),
    primary key (community_id, user_id)
);
create index if not exists idx_nexus_members_user
    on public.nexus_community_members (user_id);

-- ── 3. Anonymous per-community handles ────────────────────────────────────
-- One stable pseudonym per (user, community). Generated on first post/comment.
-- The handle text (e.g., "WildOcean42") is never derived from the user_id —
-- the API layer mints a random unused handle from a curated wordlist.
create table if not exists public.nexus_anonymous_handles (
    community_id  uuid not null references public.nexus_communities(id) on delete cascade,
    user_id       uuid not null references auth.users(id) on delete cascade,
    handle        text not null,
    -- Tiny avatar seed (deterministic from user_id+community for the same
    -- generated svg/blob across sessions, but unlinkable across communities).
    avatar_seed   text not null,
    created_at    timestamptz not null default now(),
    primary key (community_id, user_id),
    -- Within ONE community, no two users may share a handle. Across
    -- communities the same handle string may recur — that's intentional and
    -- prevents cross-community fingerprinting.
    unique (community_id, handle)
);

-- ── 4. Vault embeddings (per user) ────────────────────────────────────────
-- Detached from `symp_vault_profiles` to keep that table light and to avoid
-- a hard pgvector dependency for users not in the Nexus.
create table if not exists public.nexus_vault_embeddings (
    user_id        uuid primary key references auth.users(id) on delete cascade,
    embedding      vector(1536) not null,
    -- Source text version — bump every time the analyser produces a new
    -- vault summary so we know when to recompute.
    source_version text not null,
    computed_at    timestamptz not null default now()
);
create index if not exists idx_nexus_vault_embeddings_ivfflat
    on public.nexus_vault_embeddings using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- ── 5. Posts ──────────────────────────────────────────────────────────────
create table if not exists public.nexus_posts (
    id               uuid primary key default gen_random_uuid(),
    community_id     uuid not null references public.nexus_communities(id) on delete cascade,
    author_user_id   uuid not null references auth.users(id) on delete cascade,
    -- True iff author_user_id is the synthetic AI participant. Cheap to
    -- branch on instead of joining auth.users.
    is_ai_author     boolean not null default false,
    title            text,
    body             text not null,
    -- Per-post embedding for community-internal "more like this" surfacing
    -- and for the AI participant to decide what to comment on.
    embedding        vector(1536),
    -- Risk classifier output. 'critical' → soft-hidden + escalation pipeline.
    risk_level       text not null default 'normal'
                       check (risk_level in ('normal','elevated','critical')),
    is_soft_hidden   boolean not null default false,
    -- Aggregate impact denorm — bumped by trigger on nexus_impacts.
    impact_count     integer not null default 0,
    comment_count    integer not null default 0,
    -- AI TL;DR of the comment thread once it crosses the participation
    -- threshold (default 15 comments). Refreshed by a CRON.
    ai_tldr          text,
    ai_tldr_at       timestamptz,
    -- AI participant has commented at least once (zero-engagement nudge).
    ai_replied_at    timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);
create index if not exists idx_nexus_posts_community_recent
    on public.nexus_posts (community_id, created_at desc)
    where is_soft_hidden = false;
create index if not exists idx_nexus_posts_author
    on public.nexus_posts (author_user_id, created_at desc);
create index if not exists idx_nexus_posts_zero_engagement
    on public.nexus_posts (created_at)
    where comment_count = 0 and ai_replied_at is null and is_soft_hidden = false;
create index if not exists idx_nexus_posts_critical
    on public.nexus_posts (created_at desc)
    where risk_level = 'critical';
create index if not exists idx_nexus_posts_embed_ivfflat
    on public.nexus_posts using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- ── 6. Comments ───────────────────────────────────────────────────────────
create table if not exists public.nexus_comments (
    id              uuid primary key default gen_random_uuid(),
    post_id         uuid not null references public.nexus_posts(id) on delete cascade,
    author_user_id  uuid not null references auth.users(id) on delete cascade,
    is_ai_author    boolean not null default false,
    parent_id       uuid references public.nexus_comments(id) on delete cascade,
    body            text not null,
    risk_level      text not null default 'normal'
                       check (risk_level in ('normal','elevated','critical')),
    is_soft_hidden  boolean not null default false,
    impact_count    integer not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists idx_nexus_comments_post
    on public.nexus_comments (post_id, created_at asc)
    where is_soft_hidden = false;
create index if not exists idx_nexus_comments_author
    on public.nexus_comments (author_user_id, created_at desc);

-- ── 7. Impacts (replaces upvote/downvote) ─────────────────────────────────
-- Positive-only reaction set. One row per (user, target, type) — a user can
-- give multiple types of impact to the same post but only once each.
create table if not exists public.nexus_impacts (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    -- Exactly one of post_id / comment_id is non-null (CHECK below).
    post_id         uuid references public.nexus_posts(id) on delete cascade,
    comment_id      uuid references public.nexus_comments(id) on delete cascade,
    impact_type     text not null
                       check (impact_type in ('felt_seen','resonated','helpful','sending_strength')),
    created_at      timestamptz not null default now(),
    check ((post_id is not null) <> (comment_id is not null))
);
create unique index if not exists uniq_nexus_impact_post
    on public.nexus_impacts (user_id, post_id, impact_type)
    where post_id is not null;
create unique index if not exists uniq_nexus_impact_comment
    on public.nexus_impacts (user_id, comment_id, impact_type)
    where comment_id is not null;
create index if not exists idx_nexus_impacts_post
    on public.nexus_impacts (post_id);
create index if not exists idx_nexus_impacts_comment
    on public.nexus_impacts (comment_id);

-- Triggers to keep impact_count and comment_count denorms fresh.
create or replace function public.nexus_bump_impact_count()
returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        if new.post_id is not null then
            update public.nexus_posts set impact_count = impact_count + 1 where id = new.post_id;
        elsif new.comment_id is not null then
            update public.nexus_comments set impact_count = impact_count + 1 where id = new.comment_id;
        end if;
    elsif tg_op = 'DELETE' then
        if old.post_id is not null then
            update public.nexus_posts set impact_count = greatest(0, impact_count - 1) where id = old.post_id;
        elsif old.comment_id is not null then
            update public.nexus_comments set impact_count = greatest(0, impact_count - 1) where id = old.comment_id;
        end if;
    end if;
    return null;
end;
$$;
drop trigger if exists trg_nexus_impact_bump on public.nexus_impacts;
create trigger trg_nexus_impact_bump
    after insert or delete on public.nexus_impacts
    for each row execute function public.nexus_bump_impact_count();

create or replace function public.nexus_bump_comment_count()
returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        update public.nexus_posts
            set comment_count = comment_count + 1, updated_at = now()
            where id = new.post_id;
    elsif tg_op = 'DELETE' then
        update public.nexus_posts
            set comment_count = greatest(0, comment_count - 1)
            where id = old.post_id;
    end if;
    return null;
end;
$$;
drop trigger if exists trg_nexus_comment_bump on public.nexus_comments;
create trigger trg_nexus_comment_bump
    after insert or delete on public.nexus_comments
    for each row execute function public.nexus_bump_comment_count();

-- ── 8. Resonance score cache ──────────────────────────────────────────────
-- Pairwise (viewer, target) cosine score. Computed lazily on feed render and
-- written-through here so subsequent renders are O(1). TTL is enforced at
-- read time (compare against vault source_version).
create table if not exists public.nexus_resonance_scores (
    viewer_user_id  uuid not null references auth.users(id) on delete cascade,
    target_user_id  uuid not null references auth.users(id) on delete cascade,
    -- Cosine similarity in [-1, 1]; we store as numeric for stable display.
    score           numeric(6,5) not null,
    -- Source-version pair so we know when either side's vault has moved on.
    viewer_version  text not null,
    target_version  text not null,
    computed_at     timestamptz not null default now(),
    primary key (viewer_user_id, target_user_id)
);
create index if not exists idx_nexus_resonance_target
    on public.nexus_resonance_scores (target_user_id);

-- ── 9. Trend signals (rolling window for the TrendAnalyzer) ───────────────
-- Append-only ledger of (theme, score, time). The analyzer reads the last 24h
-- and decides whether to spawn a pop-up community.
create table if not exists public.nexus_trend_signals (
    id            uuid primary key default gen_random_uuid(),
    theme_key     text not null,                                 -- e.g. 'exam_anxiety'
    theme_label   text not null,
    -- Loose JSON so the analyzer can stash whatever evidence it likes.
    evidence      jsonb not null default '{}'::jsonb,
    weight        numeric(6,3) not null default 1.0,
    observed_at   timestamptz not null default now()
);
create index if not exists idx_nexus_trend_theme_time
    on public.nexus_trend_signals (theme_key, observed_at desc);

-- ── 10. AI participant identity ───────────────────────────────────────────
-- Stable pointer to the synthetic auth.users row that the AI speaks through.
-- Filled in once at deploy time; the row is created via supabase admin
-- (auth.users is not directly insertable from a migration).
create table if not exists public.nexus_ai_identity (
    id            int primary key default 1 check (id = 1),
    user_id       uuid references auth.users(id) on delete set null,
    display_name  text not null default 'Echo',
    -- Tagline shown next to AI replies in the UI ("Relatable Digital Entity").
    tagline       text not null default 'A voice that listens back.',
    updated_at    timestamptz not null default now()
);
insert into public.nexus_ai_identity (id) values (1) on conflict do nothing;

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Reading is permissive within public communities. Writing is owner-only.
-- Service role (server modules) bypasses RLS for AI posts, denorms, etc.

alter table public.nexus_communities          enable row level security;
alter table public.nexus_community_members    enable row level security;
alter table public.nexus_anonymous_handles    enable row level security;
alter table public.nexus_vault_embeddings     enable row level security;
alter table public.nexus_posts                enable row level security;
alter table public.nexus_comments             enable row level security;
alter table public.nexus_impacts              enable row level security;
alter table public.nexus_resonance_scores     enable row level security;
alter table public.nexus_trend_signals        enable row level security;
alter table public.nexus_ai_identity          enable row level security;

-- Communities: anyone authenticated can list public communities.
drop policy if exists nexus_communities_read on public.nexus_communities;
create policy nexus_communities_read on public.nexus_communities
    for select using (
        visibility = 'public'
        or exists (
            select 1 from public.nexus_community_members m
            where m.community_id = nexus_communities.id and m.user_id = auth.uid()
        )
    );

-- Members: a user can see their own membership rows. Cross-user discovery
-- is done via the API layer through anonymous handles, never by joining
-- this table from the browser.
drop policy if exists nexus_members_self_read on public.nexus_community_members;
create policy nexus_members_self_read on public.nexus_community_members
    for select using (auth.uid() = user_id);
drop policy if exists nexus_members_self_write on public.nexus_community_members;
create policy nexus_members_self_write on public.nexus_community_members
    for insert with check (auth.uid() = user_id);
drop policy if exists nexus_members_self_leave on public.nexus_community_members;
create policy nexus_members_self_leave on public.nexus_community_members
    for delete using (auth.uid() = user_id);

-- Handles: a user reads ONLY their own handle rows. The API joins through
-- the service role to reveal other users' handles to peers.
drop policy if exists nexus_handles_self_read on public.nexus_anonymous_handles;
create policy nexus_handles_self_read on public.nexus_anonymous_handles
    for select using (auth.uid() = user_id);

-- Vault embeddings: owner-only.
drop policy if exists nexus_vault_emb_owner_read on public.nexus_vault_embeddings;
create policy nexus_vault_emb_owner_read on public.nexus_vault_embeddings
    for select using (auth.uid() = user_id);

-- Posts: readable in any public community OR if the viewer is a member.
-- Soft-hidden posts are visible only to their author.
drop policy if exists nexus_posts_read on public.nexus_posts;
create policy nexus_posts_read on public.nexus_posts
    for select using (
        (is_soft_hidden = false and exists (
            select 1 from public.nexus_communities c
            where c.id = nexus_posts.community_id
              and (
                c.visibility = 'public'
                or exists (
                    select 1 from public.nexus_community_members m
                    where m.community_id = c.id and m.user_id = auth.uid()
                )
              )
        ))
        or auth.uid() = author_user_id
    );

drop policy if exists nexus_posts_owner_write on public.nexus_posts;
create policy nexus_posts_owner_write on public.nexus_posts
    for insert with check (auth.uid() = author_user_id);
drop policy if exists nexus_posts_owner_update on public.nexus_posts;
create policy nexus_posts_owner_update on public.nexus_posts
    for update using (auth.uid() = author_user_id) with check (auth.uid() = author_user_id);
drop policy if exists nexus_posts_owner_delete on public.nexus_posts;
create policy nexus_posts_owner_delete on public.nexus_posts
    for delete using (auth.uid() = author_user_id);

-- Comments: same shape as posts.
drop policy if exists nexus_comments_read on public.nexus_comments;
create policy nexus_comments_read on public.nexus_comments
    for select using (
        (is_soft_hidden = false and exists (
            select 1 from public.nexus_posts p
            join public.nexus_communities c on c.id = p.community_id
            where p.id = nexus_comments.post_id
              and (
                c.visibility = 'public'
                or exists (
                    select 1 from public.nexus_community_members m
                    where m.community_id = c.id and m.user_id = auth.uid()
                )
              )
        ))
        or auth.uid() = author_user_id
    );
drop policy if exists nexus_comments_owner_write on public.nexus_comments;
create policy nexus_comments_owner_write on public.nexus_comments
    for insert with check (auth.uid() = author_user_id);
drop policy if exists nexus_comments_owner_delete on public.nexus_comments;
create policy nexus_comments_owner_delete on public.nexus_comments
    for delete using (auth.uid() = author_user_id);

-- Impacts: any authenticated user can give impact; only the giver can
-- withdraw it. Reading is public-within-community via the joins.
drop policy if exists nexus_impacts_read on public.nexus_impacts;
create policy nexus_impacts_read on public.nexus_impacts
    for select using (true);
drop policy if exists nexus_impacts_self_write on public.nexus_impacts;
create policy nexus_impacts_self_write on public.nexus_impacts
    for insert with check (auth.uid() = user_id);
drop policy if exists nexus_impacts_self_delete on public.nexus_impacts;
create policy nexus_impacts_self_delete on public.nexus_impacts
    for delete using (auth.uid() = user_id);

-- Resonance scores: viewer-scoped only.
drop policy if exists nexus_resonance_viewer_read on public.nexus_resonance_scores;
create policy nexus_resonance_viewer_read on public.nexus_resonance_scores
    for select using (auth.uid() = viewer_user_id);

-- Trend signals + AI identity: server-only. No browser-readable policy.

-- ── updated_at touch triggers ─────────────────────────────────────────────
-- Reuse the symp_touch_updated_at function defined in the unified-soul
-- migration. (CREATE OR REPLACE there means it's always present.)
drop trigger if exists trg_nexus_communities_touch on public.nexus_communities;
create trigger trg_nexus_communities_touch
    before update on public.nexus_communities
    for each row execute function public.symp_touch_updated_at();

drop trigger if exists trg_nexus_posts_touch on public.nexus_posts;
create trigger trg_nexus_posts_touch
    before update on public.nexus_posts
    for each row execute function public.symp_touch_updated_at();

drop trigger if exists trg_nexus_comments_touch on public.nexus_comments;
create trigger trg_nexus_comments_touch
    before update on public.nexus_comments
    for each row execute function public.symp_touch_updated_at();

commit;
