-- Minit — reap stale 'active' sessions whose listener has gone offline.
--
-- pagehide marks a listener offline immediately; the stale-listener cron marks
-- them offline after ~2 min of no heartbeat. Either way, if the listener for an
-- active session is offline, the chat is dead — cancel it so the seeker isn't
-- stranded resuming a dead chat, and so it never lingers as 'active' forever.
-- Cancelled (not completed) → it is NOT charged against the seeker's minits.
do $$ begin perform cron.unschedule('minit-expire-active'); exception when others then null; end $$;
select cron.schedule('minit-expire-active', '*/2 * * * *',
  $$update public.connect_sessions set status='cancelled'
     where status='active'
       and listener_id in (select id from public.listeners where is_online = false)$$);
