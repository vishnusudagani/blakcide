-- Enable Supabase Realtime for group chat tables so postgres_changes events fire.
-- Belt-and-suspenders: the frontend also uses Broadcast relay for instant delivery.

ALTER PUBLICATION supabase_realtime ADD TABLE group_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE group_rooms;
