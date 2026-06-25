-- 1k-DAU hot-path indexes (additive; messages had only pkey + embedding index).
create index if not exists messages_chat_created_idx            on public.messages (chat_id, created_at);
create index if not exists messages_created_idx                 on public.messages (created_at);
create index if not exists messages_session_created_idx         on public.messages (session_id, created_at);
create index if not exists connect_messages_session_created_idx on public.connect_messages (session_id, created_at);
