-- Pin / favourite a Blak chat thread.
-- pinned_at = when the user pinned it (NULL = not pinned). Pinned threads sort to
-- the top of the history drawer, newest-pinned first. Owner RLS on `chats`
-- already governs reads/writes, so no new policy is needed.

alter table public.chats add column if not exists pinned_at timestamptz;

-- Helps the drawer's "pinned first, then recent" ordering on busy accounts.
create index if not exists chats_user_pinned_idx
  on public.chats (user_id, pinned_at desc nulls last, created_at desc);
