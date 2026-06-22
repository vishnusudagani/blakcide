-- Nexus — resonance-ranked "For you" feed (NEXUS-GAPS.md Phase 2, #17/#20).
--
-- v1 = a HEURISTIC resonance score (shared-tribe overlap + impact + recency) — no
-- embeddings, so it works immediately with zero budget. The full pgvector match
-- (decision: "full pgvector") is a documented upgrade: embed user profiles + posts
-- (free Gemini text-embedding works) into nexus_vault_embeddings, then swap the
-- score for cosine similarity. TODO(resonance-pgvector).
--
-- Identity-safe: returns the opaque per-tribe token/handle (never a uid); honours
-- block filter + soft-hide; security_invoker not needed (definer + explicit checks).

begin;

create or replace function public.nexus_feed(p_limit int default 30)
returns table(
  id uuid, community_id uuid, community_name text, is_ai_author boolean,
  title text, body text, image_url text, impact_count int, comment_count int,
  created_at timestamptz, author_token uuid, author_handle text, avatar_seed text,
  is_mine boolean, my_resonated boolean, resonance int
)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  return query
  with my_tribes as (
    select m.community_id as tribe_id from public.nexus_community_members m where m.user_id = v_uid
  )
  select p.id, p.community_id, c.name, p.is_ai_author, p.title, p.body, p.image_url,
         p.impact_count, p.comment_count, p.created_at,
         hp.token, coalesce(hp.handle, ''), coalesce(hp.avatar_seed, ''),
         coalesce(p.author_user_id = v_uid, false),
         exists (select 1 from public.nexus_impacts i
                 where i.post_id = p.id and i.user_id = v_uid and i.impact_type = 'resonated'),
         least(100, 45
           + case when p.community_id in (select tribe_id from my_tribes) then 30 else 0 end
           + least(20, p.impact_count * 3)
           + greatest(0, 10 - (extract(epoch from (now() - p.created_at)) / 86400)::int))::int
  from public.nexus_posts p
  join public.nexus_communities c on c.id = p.community_id
  left join lateral public.nexus_handle_public(p.community_id, p.author_user_id) hp on true
  where p.is_soft_hidden = false
    and (c.visibility = 'public' or p.community_id in (select tribe_id from my_tribes))
    and not public.nexus_is_blocked(v_uid, p.author_user_id)
  order by
    (case when p.community_id in (select tribe_id from my_tribes) then 1 else 0 end) desc,
    p.created_at desc
  limit greatest(1, least(p_limit, 60));
end;
$$;
grant execute on function public.nexus_feed(int) to anon, authenticated;

commit;
