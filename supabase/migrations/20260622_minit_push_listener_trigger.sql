-- Phase 5: when a seeker is matched (connect_sessions insert, pending + listener),
-- push the listener via pg_net → push-send. Reads the shared cron secret from Vault.
-- Fully guarded — a push failure never blocks the match.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
create or replace function public.minit_push_listener() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_secret text;
begin
  if new.status <> 'pending' or new.listener_id is null then return new; end if;
  select user_id into v_uid from public.listeners where id = new.listener_id;
  if v_uid is null then return new; end if;
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret' limit 1;
  exception when others then v_secret := null; end;
  if v_secret is null then return new; end if;
  begin
    perform net.http_post(
      url := 'https://uoosspumdmffccinszuj.supabase.co/functions/v1/push-send',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('user_id', v_uid, 'title', 'Someone needs you', 'body', 'A seeker just reached out on Minit.', 'url', '/beta/listen/', 'tag', 'minit-incoming')
    );
  exception when others then null; end;
  return new;
end $$;

drop trigger if exists trg_minit_push_listener on public.connect_sessions;
create trigger trg_minit_push_listener after insert on public.connect_sessions
  for each row execute function public.minit_push_listener();
