-- ════════════════════════════════════════════════════════════════════════════
-- 20260617_security_hardening.sql
-- Addresses Supabase security-advisor findings surfaced in the beta review.
--
-- Two parts:
--   PART A — SAFE TO APPLY: additive / non-breaking. Review, then run.
--   PART B — NEEDS REVIEW:  correct fixes that depend on product intent
--            (anonymous Nexus model, public media buckets, RLS-helper funcs).
--            Left COMMENTED so running this file can't break the live app.
--            Uncomment deliberately, per item, once the intent is confirmed.
-- ════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- PART A · SAFE TO APPLY
-- ─────────────────────────────────────────────────────────────────────────────

-- A1. ERROR · security_definer_view
--     public.symp_credit_account_summary runs with the definer's rights, which
--     bypasses the querying user's RLS. Switch to security_invoker so the
--     caller's RLS applies.
--     CHECK BEFORE APPLY: if an admin surface relied on this view to read ALL
--     users' credit rows, make sure that path uses the service role / an admin
--     RLS policy rather than the old definer-bypass.
alter view public.symp_credit_account_summary set (security_invoker = on);


-- A2. WARN · function_search_path_mutable
--     Pin search_path on utility/trigger functions so it can't be hijacked.
--     'public' keeps existing unqualified table references working (non-breaking).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'touch_global_settings_updated_at','nexus_bump_impact_count',
        'nexus_bump_comment_count','update_symp_updated_at_column',
        'symp_touch_updated_at','match_journal_entries',
        'touch_journal_entries_updated_at','teamos_set_updated_at',
        'touch_symp_voice_clones_updated_at','get_active_voice_clone','nexus_pulse')
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;


-- A3. Feature · mood_logs
--     Backs the home "How are you feeling?" check-in so it actually persists
--     (and can inform Blak) instead of being a throwaway toast. Owner-only RLS.
create table if not exists public.mood_logs (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references auth.users(id) on delete cascade,
    mood       text not null check (mood in ('great','okay','low','anxious','angry')),
    created_at timestamptz not null default now()
);
alter table public.mood_logs enable row level security;

drop policy if exists mood_logs_owner_select on public.mood_logs;
create policy mood_logs_owner_select on public.mood_logs
    for select using (auth.uid() = user_id);

drop policy if exists mood_logs_owner_insert on public.mood_logs;
create policy mood_logs_owner_insert on public.mood_logs
    for insert with check (auth.uid() = user_id);

create index if not exists mood_logs_user_created_idx
    on public.mood_logs (user_id, created_at desc);


-- ─────────────────────────────────────────────────────────────────────────────
-- PART B · NEEDS REVIEW — do NOT run blindly (would risk breaking live features)
-- ─────────────────────────────────────────────────────────────────────────────

-- B1. WARN · rls_policy_always_true on group_rooms / group_messages
--     These power Nexus ANONYMOUS DMs: user ids are TEXT (app-generated, not
--     auth.uid()), so RLS can't bind rows to an authenticated user. The
--     always-true policies are a side effect of that anonymous design.
--     The dangerous one is UPDATE-anything on group_rooms (any caller can
--     rename / repoint any room). Recommended real fix: route writes through a
--     SECURITY DEFINER rpc that validates room membership (created_by /
--     user_a_id / user_b_id) against an app-issued token, then:
--
--         -- drop policy if exists group_rooms_update on public.group_rooms;
--         -- create policy group_rooms_update on public.group_rooms
--         --   for update using ( /* membership check */ ) with check ( /* same */ );
--
--     Same idea for group_messages_insert (anyone can post into any room).
--     Decide the auth model first — see app/group-chat.html.

-- B2. WARN · anon can EXECUTE SECURITY DEFINER functions
--     Revoke anon EXECUTE on the privileged ones no anonymous client should call
--     directly. CAUTION: some flagged functions (uid_is_listener,
--     uid_is_any_listener, nexus_is_member, can_access_session) are likely used
--     INSIDE RLS policies and must stay executable by the roles those policies
--     evaluate for — revoking them can BREAK RLS. Verify each is not referenced
--     by a policy (pg_policies.qual/with_check) before uncommenting.
--     Clearly-safe candidates (not RLS helpers, server/admin-only):
--
--         -- revoke execute on function public.is_admin                     from anon;
--         -- revoke execute on function public.nexus_sweep_rooms            from anon;
--         -- revoke execute on function public.update_listener_rating       from anon;
--         -- revoke execute on function public.teamos_audit_record          from anon;
--         -- revoke execute on function public.teamos_notify_assignment     from anon;
--         -- revoke execute on function public.teamos_notify_event_invite   from anon;
--         -- revoke execute on function public.teamos_notify_mentions       from anon;
--         -- revoke execute on function public.teamos_materialize_recurrence from anon;
--     (Add explicit arg signatures if a name is overloaded.)

-- B3. WARN · public_bucket_allows_listing
--     Buckets: avatars, chat_images, group-media, journal_media, nexus-img,
--     teamos-avatars, voice_notes are public AND list-enabled, so filenames can
--     be enumerated. voice_notes / chat_images / journal_media hold PRIVATE user
--     content but are currently served via getPublicUrl() (see the voice-note
--     upload in app/app.js). Real fix: switch those reads to createSignedUrl(),
--     THEN flip the buckets to private — doing it the other way breaks
--     playback / image display. e.g. after the app change:
--
--         -- update storage.buckets set public = false
--         --  where id in ('voice_notes','chat_images','journal_media');

-- B4. WARN · auth_leaked_password_protection is OFF
--     Enable in Dashboard → Authentication → Passwords ("Leaked password
--     protection"), or via the Management API. Not a SQL change.

-- B5. WARN · extension "vector" lives in the public schema (low-priority hygiene).
--     Optional: move it out of public once you've confirmed nothing references
--     public.<vector ops> unqualified:
--
--         -- create schema if not exists extensions;
--         -- alter extension vector set schema extensions;
