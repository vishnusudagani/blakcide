-- Let a user delete messages in their own chats. The Blak chat page (/beta/blak)
-- now persists threads server-side and reads/writes `chats` + `messages` directly
-- under owner RLS; it needs DELETE for "regenerate" (drop the last reply) and for
-- removing a chat's messages when the chat is deleted. SELECT/INSERT policies
-- already exist; this adds the missing DELETE.
drop policy if exists "Delete own chat messages" on public.messages;
create policy "Delete own chat messages" on public.messages
  for delete using (
    chat_id is not null and exists (
      select 1 from public.chats c where c.id = messages.chat_id and c.user_id = auth.uid()
    )
  );
