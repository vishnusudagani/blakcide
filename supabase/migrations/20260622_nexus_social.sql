-- Nexus — social features (NEXUS-GAPS.md Phase 3): edit/delete (#25/#26),
-- search (#31), and realtime for discussions (#30 — publication side).

begin;

-- ── #25/#26 edit + delete your own posts/comments (owner-gated, both modes) ──
create or replace function public.nexus_edit_post(p_id uuid, p_title text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'auth required' using errcode = '28000'; end if;
  update public.nexus_posts
     set title = nullif(btrim(coalesce(p_title, '')), ''), body = coalesce(p_body, body), updated_at = now()
   where id = p_id and author_user_id = auth.uid();
end;
$$;
grant execute on function public.nexus_edit_post(uuid, text, text) to authenticated;

create or replace function public.nexus_delete_post(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'auth required' using errcode = '28000'; end if;
  delete from public.nexus_posts where id = p_id and author_user_id = auth.uid();
end;
$$;
grant execute on function public.nexus_delete_post(uuid) to authenticated;

create or replace function public.nexus_edit_comment(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'auth required' using errcode = '28000'; end if;
  update public.nexus_comments set body = coalesce(p_body, body), updated_at = now()
   where id = p_id and author_user_id = auth.uid();
end;
$$;
grant execute on function public.nexus_edit_comment(uuid, text) to authenticated;

create or replace function public.nexus_delete_comment(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'auth required' using errcode = '28000'; end if;
  delete from public.nexus_comments where id = p_id and author_user_id = auth.uid();
end;
$$;
grant execute on function public.nexus_delete_comment(uuid) to authenticated;

-- ── #31 search posts/discussions (token-safe, visible-only, block/hidden aware) ─
create or replace function public.nexus_search(p_q text, p_limit int default 30)
returns table(
  id uuid, community_id uuid, community_name text, is_ai_author boolean,
  title text, body text, image_url text, impact_count int, comment_count int,
  created_at timestamptz, author_token uuid, author_handle text, avatar_seed text, is_mine boolean
)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_q text := btrim(coalesce(p_q, ''));
begin
  if length(v_q) < 2 then return; end if;
  return query
  with my_tribes as (
    select m.community_id as tribe_id from public.nexus_community_members m where m.user_id = v_uid
  )
  select p.id, p.community_id, c.name, p.is_ai_author, p.title, p.body, p.image_url,
         p.impact_count, p.comment_count, p.created_at,
         hp.token, coalesce(hp.handle, ''), coalesce(hp.avatar_seed, ''),
         coalesce(p.author_user_id = v_uid, false)
  from public.nexus_posts p
  join public.nexus_communities c on c.id = p.community_id
  left join lateral public.nexus_handle_public(p.community_id, p.author_user_id) hp on true
  where p.is_soft_hidden = false
    and (c.visibility = 'public' or p.community_id in (select tribe_id from my_tribes))
    and not public.nexus_is_blocked(v_uid, p.author_user_id)
    and (p.title ilike '%' || v_q || '%' or p.body ilike '%' || v_q || '%')
  order by p.created_at desc
  limit greatest(1, least(p_limit, 50));
end;
$$;
grant execute on function public.nexus_search(text, int) to anon, authenticated;

-- ── #30 realtime: publish discussions so the client can live-update ─────────
do $$
begin
  begin alter publication supabase_realtime add table public.nexus_posts;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.nexus_comments; exception when duplicate_object then null; end;
end $$;

commit;
