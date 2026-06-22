-- Nexus — tribe discovery (NEXUS-GAPS.md Phase 6, #32). Public tribes ranked by
-- recent activity. Token-safe (no member identity). Native, lightweight replacement
-- for the dormant trend-analyzer pop-up-community spawner.
begin;
create or replace function public.nexus_trending_tribes(p_limit int default 8)
returns table(id uuid, name text, description text, members int, recent_posts int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.description,
         (select count(*) from public.nexus_community_members m where m.community_id = c.id)::int,
         (select count(*) from public.nexus_posts p where p.community_id = c.id and p.is_soft_hidden = false and p.created_at > now() - interval '7 days')::int
  from public.nexus_communities c
  where c.visibility = 'public' and c.archived_at is null
  order by (select count(*) from public.nexus_posts p where p.community_id = c.id and p.created_at > now() - interval '7 days') desc,
           (select count(*) from public.nexus_community_members m where m.community_id = c.id) desc,
           c.created_at desc
  limit greatest(1, least(p_limit, 20));
$$;
grant execute on function public.nexus_trending_tribes(int) to anon, authenticated;
commit;
