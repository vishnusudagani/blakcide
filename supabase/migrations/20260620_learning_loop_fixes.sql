-- Learning loop fixes found in functional testing (applied to prod via MCP).
-- 1. The "Not me" control sets status='suppressed', but the status CHECK only
--    allowed active/user_edited — it would have errored. Allow 'suppressed'.
-- 2. A USER-entered fact reinforced by behaviour kept its value but flipped
--    source user->multi, downgrading "you said" to "across Blaksyd". Keep 'user'.

alter table public.symp_knowledge_facts drop constraint if exists symp_knowledge_facts_status_check;
alter table public.symp_knowledge_facts add constraint symp_knowledge_facts_status_check
  check (status = any (array['active','user_edited','suppressed']));

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
        source       = case when public.symp_knowledge_facts.source = 'user' then 'user'
                            when public.symp_knowledge_facts.source = excluded.source then excluded.source
                            else 'multi' end,
        sensitive    = public.symp_knowledge_facts.sensitive or excluded.sensitive,
        last_seen_at = now(),
        updated_at   = now()
    where public.symp_knowledge_facts.status <> 'suppressed';
end; $$;
revoke execute on function public.knowledge_upsert(uuid,text,text,text,text,text,boolean,real,text) from public, anon, authenticated;
