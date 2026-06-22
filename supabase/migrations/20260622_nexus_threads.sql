-- Nexus — threaded replies (NEXUS-GAPS.md Phase 3, #27). A token-safe reader that
-- (unlike the view) exposes parent_id, so the client can nest replies. nexus_create_comment
-- already accepts p_parent_id.
begin;
create or replace function public.nexus_comments_threaded(p_post_id uuid)
returns table(id uuid, post_id uuid, parent_id uuid, is_ai_author boolean, body text, image_url text,
              created_at timestamptz, author_token uuid, author_handle text, avatar_seed text, is_mine boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  return query
  select c.id, c.post_id, c.parent_id, c.is_ai_author, c.body, c.image_url, c.created_at,
         hp.token, coalesce(hp.handle, ''), coalesce(hp.avatar_seed, ''), coalesce(c.author_user_id = v_uid, false)
  from public.nexus_comments c
  join public.nexus_posts p on p.id = c.post_id
  left join lateral public.nexus_handle_public(p.community_id, c.author_user_id) hp on true
  where c.post_id = p_post_id and c.is_soft_hidden = false
  order by c.created_at asc;
end;
$$;
grant execute on function public.nexus_comments_threaded(uuid) to anon, authenticated;
commit;
