-- Human Connect (Minit) — fix messages RLS for listeners.
--
-- connect_sessions.listener_id stores the listeners.id (row id), NOT the
-- listener's auth uid. The previous messages policies only allowed access when
-- s.listener_id = auth.uid(), so a listener could never read or send messages in
-- their own sessions (empty feed, can't reply). This adds a mapping so a user who
-- owns the matching listeners row is recognised as the session's listener.

drop policy if exists "Read own chat or session messages" on public.messages;
create policy "Read own chat or session messages" on public.messages
for select using (
  (chat_id is not null and exists (select 1 from public.chats c where c.id = messages.chat_id and c.user_id = auth.uid()))
  or
  (session_id is not null and exists (
    select 1 from public.connect_sessions s
    where s.id = messages.session_id and (
      s.user_id = auth.uid()
      or s.listener_id = auth.uid()
      or s.listener_id in (select l.id from public.listeners l where l.user_id = auth.uid())
    )
  ))
);

drop policy if exists "Insert own chat or session messages" on public.messages;
create policy "Insert own chat or session messages" on public.messages
for insert with check (
  (chat_id is not null and exists (select 1 from public.chats c where c.id = messages.chat_id and c.user_id = auth.uid()))
  or
  (session_id is not null and exists (
    select 1 from public.connect_sessions s
    where s.id = messages.session_id and (
      s.user_id = auth.uid()
      or s.listener_id = auth.uid()
      or s.listener_id in (select l.id from public.listeners l where l.user_id = auth.uid())
    )
  ))
);
