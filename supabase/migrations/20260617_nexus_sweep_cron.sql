-- Nexus — server-side room sweep.
-- nexus_sweep_rooms() closes rooms whose last heartbeat is stale (a client crashed
-- or closed without a clean leave). Previously it ran ONLY when some client loaded
-- the lobby, so a room could linger as "live" with phantom presence indefinitely.
-- Run it every minute via pg_cron so ghost rooms always clear.
do $$ begin perform cron.unschedule('nexus-sweep-rooms'); exception when others then null; end $$;
select cron.schedule('nexus-sweep-rooms', '* * * * *', $$select public.nexus_sweep_rooms()$$);
