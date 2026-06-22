-- Phase 5 (seeker-side push): when a waiting seeker's callback flips to 'notified'
-- (a listener freed up / came online), push them "a listener's free". Same guarded
-- pg_net → push-send path as the listener trigger.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
create or replace function public.minit_push_callback() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_secret text;
begin
  if new.status = 'notified' and (old.status is distinct from 'notified') then
    begin select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret' limit 1; exception when others then v_secret := null; end;
    if v_secret is not null then
      begin
        perform net.http_post(
          url := 'https://uoosspumdmffccinszuj.supabase.co/functions/v1/push-send',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
          body := jsonb_build_object('user_id', new.user_id, 'title', 'A listener’s free', 'body', 'Someone’s ready to talk on Minit — tap to connect.', 'url', '/beta/minit/', 'tag', 'minit-free')
        );
      exception when others then null; end;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_minit_push_callback on public.minit_callbacks;
create trigger trg_minit_push_callback after update on public.minit_callbacks
  for each row execute function public.minit_push_callback();
