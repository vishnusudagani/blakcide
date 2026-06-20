-- Learning loop P4: the reinforce/decay engine. Reinforce + suppression already
-- live in knowledge_upsert; this adds TIME-DECAY so the profile stays current.
-- Each night, facts not reinforced in over a week lose a little confidence —
-- SENSITIVE (Minit/emotional) facts fade ~2.5x faster than interests/values, so
-- a hard week never becomes a permanent record. User-entered facts never decay;
-- reinforcement resets last_seen_at and keeps active interests fresh. Faded +
-- old facts are pruned. (Applied to prod via MCP; this file is the repo record.)
create or replace function public.knowledge_decay()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.symp_knowledge_facts
    set confidence = greatest(0.05, confidence - (case when sensitive then 0.05 else 0.02 end)),
        updated_at = now()
    where status = 'active' and source <> 'user'
      and last_seen_at < now() - interval '7 days'
      and confidence > 0.05;
  delete from public.symp_knowledge_facts
    where status = 'active' and source <> 'user'
      and confidence <= 0.15 and last_seen_at < now() - interval '30 days';
end; $$;
revoke execute on function public.knowledge_decay() from public, anon, authenticated;

-- Nightly @ 22:15 UTC — after the learn jobs so reinforcement lands first.
do $$ begin perform cron.unschedule('knowledge-decay-nightly'); exception when others then null; end $$;
select cron.schedule('knowledge-decay-nightly', '15 22 * * *', $$ select public.knowledge_decay(); $$);
