-- Learning loop expansion — Phase 1: data-model + Nexus instant interest signals.
--
-- The knowledge table already has source/confidence/status/last_seen_at/evidence +
-- UNIQUE(user_id,area,key). We add ONE column — `sensitive` — the lane-separation
-- flag: sensitive facts (Minit/emotional) feed Blak's private context only and must
-- never personalize the public Nexus feed.
--
-- Then two near-real-time, no-LLM signals: joining a tribe or resonating with a post
-- creates/reinforces an INTEREST fact (source 'nexus', not sensitive). Reinforcement
-- bumps confidence; a fact the user marked "not me" (status 'suppressed') is never
-- re-added. Learning is best-effort — a hiccup never blocks the join/resonate.

alter table public.symp_knowledge_facts
  add column if not exists sensitive boolean not null default false;

-- Extend the source vocabulary for the cross-pillar loop (was: user, blak).
alter table public.symp_knowledge_facts drop constraint if exists symp_knowledge_facts_source_check;
alter table public.symp_knowledge_facts add constraint symp_knowledge_facts_source_check
  check (source = any (array['user','blak','nexus','minit','multi']));

-- Upsert/reinforce an interest fact for a (user, tribe). Reused by both triggers.
create or replace function public._nexus_learn_interest(p_user uuid, p_community uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_key text;
begin
  if p_user is null or p_community is null then return; end if;
  select name into v_name from public.nexus_communities where id = p_community;
  if v_name is null then return; end if;
  v_key := 'nexus_tribe:' || p_community::text;

  insert into public.symp_knowledge_facts
    (user_id, area, key, label, value, source, confidence, sensitive, evidence, last_seen_at, updated_at)
  values
    (p_user, 'tastes', v_key, v_name, 'Active in the ' || v_name || ' tribe on Nexus',
     'nexus', 0.6, false, 'Nexus activity', now(), now())
  on conflict (user_id, area, key) do update
    set confidence   = least(0.99, public.symp_knowledge_facts.confidence + 0.1),
        -- cross-source reinforcement (e.g. Blak chat already knew this) → 'multi'
        source       = case when public.symp_knowledge_facts.source in ('nexus','multi') then public.symp_knowledge_facts.source else 'multi' end,
        last_seen_at = now(),
        updated_at   = now()
    where public.symp_knowledge_facts.status <> 'suppressed';   -- respect "this isn't me"
end; $$;

-- Tribe join → interest fact.
create or replace function public.trg_nexus_join_learn()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin perform public._nexus_learn_interest(NEW.user_id, NEW.community_id);
  exception when others then null; end;   -- best-effort; never block the join
  return NEW;
end; $$;
drop trigger if exists trg_nexus_join_learn on public.nexus_community_members;
create trigger trg_nexus_join_learn after insert on public.nexus_community_members
  for each row execute function public.trg_nexus_join_learn();

-- Resonating with a post → reinforce interest in that post's tribe.
create or replace function public.trg_nexus_resonate_learn()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_comm uuid;
begin
  if NEW.impact_type = 'resonated' and NEW.post_id is not null then
    begin
      select community_id into v_comm from public.nexus_posts where id = NEW.post_id;
      perform public._nexus_learn_interest(NEW.user_id, v_comm);
    exception when others then null;   -- best-effort; never block the resonate
    end;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_nexus_resonate_learn on public.nexus_impacts;
create trigger trg_nexus_resonate_learn after insert on public.nexus_impacts
  for each row execute function public.trg_nexus_resonate_learn();
