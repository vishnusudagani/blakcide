-- ── Group Chat Tables ─────────────────────────────────────────────────────────
--
-- group_rooms  : one row per room, tracks participants
-- group_messages : messages from both users + AI replies
--
-- RLS: anon users can insert/select their own rooms/messages.
-- The room_code acts as the invite token — no auth required to join.

-- ── group_rooms ───────────────────────────────────────────────────────────────
create table if not exists group_rooms (
    id           uuid primary key default gen_random_uuid(),
    created_at   timestamptz not null default now(),
    room_code    text not null unique,           -- 6-char uppercase invite code
    created_by   text not null,                  -- userId (client-generated)
    user_a_id    text not null,
    user_a_name  text not null,
    user_b_id    text,                           -- null until second user joins
    user_b_name  text,
    participants integer not null default 1      -- 1 or 2
);

-- Auto-expire rooms after 24h (optional — requires pg_cron or manual cleanup)
-- Not enforced here; UI can handle stale rooms gracefully.

create index if not exists group_rooms_code_idx on group_rooms(room_code);

-- ── group_messages ────────────────────────────────────────────────────────────
create table if not exists group_messages (
    id           uuid primary key default gen_random_uuid(),
    created_at   timestamptz not null default now(),
    room_id      uuid not null references group_rooms(id) on delete cascade,
    user_id      text not null,                  -- userId or 'ai'
    user_name    text not null,                  -- display name or 'AI'
    role         text not null check (role in ('user','assistant')),
    content      text not null
);

create index if not exists group_messages_room_idx on group_messages(room_id, created_at);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table group_rooms    enable row level security;
alter table group_messages enable row level security;

-- Anyone with the anon key can create rooms
create policy "anon can insert rooms"
    on group_rooms for insert
    to anon
    with check (true);

-- Anyone can read rooms (needed to join by code)
create policy "anon can read rooms"
    on group_rooms for select
    to anon
    using (true);

-- Anyone can update rooms (to add second participant)
create policy "anon can update rooms"
    on group_rooms for update
    to anon
    using (true);

-- Anyone with room access can insert messages
create policy "anon can insert messages"
    on group_messages for insert
    to anon
    with check (true);

-- Anyone can read messages in rooms they know the ID of
create policy "anon can read messages"
    on group_messages for select
    to anon
    using (true);
