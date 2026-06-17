-- Nexus — realtime membership.
-- The home "Your tribes" swiper subscribes to this account's membership rows so a
-- join/leave (here, another tab, or another device) re-renders instantly. Requires
-- the table in the realtime publication; REPLICA IDENTITY FULL so DELETE (leave)
-- events still carry user_id for the user_id=eq.<me> filter to match.
alter publication supabase_realtime add table public.nexus_community_members;
alter table public.nexus_community_members replica identity full;
