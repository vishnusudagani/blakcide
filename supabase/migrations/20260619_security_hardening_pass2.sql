-- ─────────────────────────────────────────────────────────────────────────
-- Security hardening pass 2 (pre-launch audit fixes). Tightens over-permissive
-- surfaces. No rows are dropped — only access is narrowed. Idempotent.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Orphaned legacy "group_*" tables — no current app code references them
--    (grep-confirmed), yet they held 32 rooms / 177 messages readable AND
--    writable/updatable by anyone (public + USING(true)). Lock to service-role.
drop policy if exists group_rooms_select  on public.group_rooms;
drop policy if exists group_rooms_insert  on public.group_rooms;
drop policy if exists group_rooms_update  on public.group_rooms;
drop policy if exists group_messages_select on public.group_messages;
drop policy if exists group_messages_insert on public.group_messages;

-- 2. user_profiles (full_name / age / gender / dob) was world-readable by
--    anyone, incl. logged-out. Drop the two "anyone can read" policies; the
--    existing owner ALL policy already grants the owner full self-access.
drop policy if exists "Anyone can read profiles"       on public.user_profiles;
drop policy if exists "Anyone can read user profiles"  on public.user_profiles;

-- 3. listener_reviews — the insert check only verified user_id = auth.uid(),
--    so any user could forge a 1–5★ review for an arbitrary session/listener
--    (folded into the public average by the rating trigger). Require that the
--    reviewer was the seeker in a COMPLETED session.
drop policy if exists lr_insert_own on public.listener_reviews;
create policy lr_insert_own on public.listener_reviews
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.connect_sessions cs
      where cs.id = listener_reviews.session_id
        and cs.user_id = auth.uid()
        and cs.status = 'completed'
    )
  );

-- 4. Private media buckets allowed enumeration — a broad SELECT policy let
--    clients .list() every user's files. Scope SELECT to the owner. Display
--    uses public object URLs (bucket stays public=true), so rendering is
--    unaffected; this only removes cross-user listing/enumeration.
--    (Full private-bucket + signed-URL migration is tracked as a follow-up.)
drop policy if exists chat_images_select on storage.objects;
create policy chat_images_select on storage.objects
  for select to authenticated
  using (bucket_id = 'chat_images' and auth.uid() = owner);

drop policy if exists "Public Listen Access" on storage.objects;  -- voice_notes
create policy voice_notes_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'voice_notes' and auth.uid() = owner);

drop policy if exists "Allow Uplaods 1wzr9p8_0" on storage.objects;  -- journal_media SELECT
create policy journal_media_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'journal_media' and auth.uid() = owner);
