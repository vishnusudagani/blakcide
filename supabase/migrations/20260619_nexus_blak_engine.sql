-- Blak community-presence engine schedule + room hook.
-- Drives the `nexus-blak` Edge Function. The function URL + cron secret live in
-- Vault (nexus_blak_url, nexus_blak_cron_secret). The function fails closed
-- until NEXUS_BLAK_CRON_SECRET is also set in Edge secrets (matching the Vault value).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ~every 2 hours, nudge Blak to make one light tribe move (it self-rate-limits).
do $$ begin perform cron.unschedule('nexus-blak-2h'); exception when others then null; end $$;
select cron.schedule('nexus-blak-2h', '7 */2 * * *', $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret')
               ),
    body    := '{}'::jsonb
  );
$cron$);

-- When a live room is created, ask Blak to greet it (async; non-blocking).
create or replace function public.nexus_blak_on_room()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  perform net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret')
               ),
    body    := jsonb_build_object('mode', 'room_opener', 'room_id', NEW.id)
  );
  return NEW;
end; $fn$;

drop trigger if exists trg_nexus_blak_room on public.nexus_rooms;
create trigger trg_nexus_blak_room after insert on public.nexus_rooms
  for each row execute function public.nexus_blak_on_room();
