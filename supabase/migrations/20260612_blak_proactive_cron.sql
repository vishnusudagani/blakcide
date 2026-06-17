-- Proactive engine schedule — pg_cron drives blak-proactive.
--
-- Every 15 minutes, ping the blak-proactive Edge Function, which fires DUE
-- triggers from symp_action_loop but only messages users whose 24h WhatsApp
-- window is still warm (never a paid template). The function URL + cron secret
-- are read from Supabase Vault so no secrets live in this migration.
--
-- PREREQUISITES (run once, in the SQL editor, with your real values):
--   select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1/blak-proactive', 'blak_proactive_url');
--   select vault.create_secret('<the CRON_SECRET you set in Edge secrets>', 'blak_cron_secret');

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any prior schedule of the same name before re-creating.
do $$
begin
  perform cron.unschedule('blak-proactive-15m');
exception when others then
  null; -- not scheduled yet
end $$;

select cron.schedule(
  'blak-proactive-15m',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'blak_proactive_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'blak_cron_secret')
               ),
    body    := '{}'::jsonb
  );
  $$
);

commit;
