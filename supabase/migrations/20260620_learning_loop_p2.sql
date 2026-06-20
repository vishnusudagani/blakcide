-- Learning loop Phase 2 — Nexus posts/comments → nightly LLM topic synthesis.
-- (Applied to prod via MCP; this file is the repo record. Drives the nexus-learn
-- Edge Function. Reuses NEXUS_BLAK_CRON_SECRET; URL + secret live in Vault.)

-- General reinforce-aware upsert (also used by the Minit synthesis in P3).
create or replace function public.knowledge_upsert(
  p_user uuid, p_area text, p_key text, p_label text, p_value text,
  p_source text, p_sensitive boolean default false, p_confidence real default 0.55,
  p_evidence text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_area is null or coalesce(p_key,'') = '' or coalesce(p_value,'') = '' then return; end if;
  if p_area not in ('identity','people','world','inner','goals','tastes','other') then p_area := 'other'; end if;
  if p_source not in ('user','blak','nexus','minit','multi') then p_source := 'other'; end if;

  insert into public.symp_knowledge_facts
    (user_id, area, key, label, value, source, confidence, sensitive, evidence, last_seen_at, updated_at)
  values
    (p_user, p_area, left(p_key, 120), coalesce(nullif(p_label,''), left(p_value, 60)), left(p_value, 400),
     p_source, greatest(0.3, least(0.9, p_confidence)), coalesce(p_sensitive, false), p_evidence, now(), now())
  on conflict (user_id, area, key) do update
    set confidence   = least(0.99, public.symp_knowledge_facts.confidence + 0.12),
        value        = case when public.symp_knowledge_facts.source = 'user' then public.symp_knowledge_facts.value else excluded.value end,
        label        = case when public.symp_knowledge_facts.source = 'user' then public.symp_knowledge_facts.label else excluded.label end,
        source       = case when public.symp_knowledge_facts.source = excluded.source then excluded.source else 'multi' end,
        sensitive    = public.symp_knowledge_facts.sensitive or excluded.sensitive,
        last_seen_at = now(),
        updated_at   = now()
    where public.symp_knowledge_facts.status <> 'suppressed';
end; $$;
revoke execute on function public.knowledge_upsert(uuid,text,text,text,text,text,boolean,real,text) from public, anon, authenticated;

-- Nightly (21:30 UTC ≈ 3am IST). Nexus is refresh-based, so a daily batch fits.
do $$ begin
  if not exists (select 1 from vault.secrets where name='nexus_learn_url') then
    perform vault.create_secret('https://uoosspumdmffccinszuj.supabase.co/functions/v1/nexus-learn','nexus_learn_url');
  end if;
end $$;
do $$ begin perform cron.unschedule('nexus-learn-nightly'); exception when others then null; end $$;
select cron.schedule('nexus-learn-nightly', '30 21 * * *', $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_learn_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nexus_blak_cron_secret')
               ),
    body    := '{}'::jsonb
  );
$cron$);
