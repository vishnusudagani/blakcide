-- Nexus — @blak summon (NEXUS-GAPS.md Phase 5, #45). When a human post/comment
-- mentions "@blak", ping the nexus-blak edge fn (mode='mention') to reply directly.
-- Mirrors nexus_blak_on_room. Fail-safe: if the engine's vault secrets aren't set
-- (engine not activated), net.http_post gets a NULL url → caught → harmless no-op.
begin;
create or replace function public.nexus_blak_mention_post() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.is_ai_author is true then return NEW; end if;
  if position('@blak' in lower(coalesce(NEW.title, '') || ' ' || coalesce(NEW.body, ''))) = 0 then return NEW; end if;
  perform net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret')),
    body    := jsonb_build_object('mode', 'mention', 'post_id', NEW.id)
  );
  return NEW;
exception when others then return NEW;
end; $fn$;
drop trigger if exists trg_nexus_blak_mention_post on public.nexus_posts;
create trigger trg_nexus_blak_mention_post after insert on public.nexus_posts
  for each row execute function public.nexus_blak_mention_post();

create or replace function public.nexus_blak_mention_comment() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.is_ai_author is true then return NEW; end if;
  if position('@blak' in lower(coalesce(NEW.body, ''))) = 0 then return NEW; end if;
  perform net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret')),
    body    := jsonb_build_object('mode', 'mention', 'comment_id', NEW.id)
  );
  return NEW;
exception when others then return NEW;
end; $fn$;
drop trigger if exists trg_nexus_blak_mention_comment on public.nexus_comments;
create trigger trg_nexus_blak_mention_comment after insert on public.nexus_comments
  for each row execute function public.nexus_blak_mention_comment();
commit;
