-- Nexus server-proxy — handle-resolution fix (follows 20260621_nexus_server_proxy.sql).
--
-- The identity-safe views are security_invoker, so their join to
-- nexus_anonymous_handles runs under the CALLER's RLS — and that table's policy
-- is self-read-only (nexus_handles_self_read). Result: a viewer could only see
-- their OWN handle, so author_token/author_handle came back null for everyone
-- else's posts. We can't broaden the table's RLS because it also holds raw user_id.
--
-- Fix: resolve the PUBLIC pseudonym (token/handle/avatar_seed only) through a
-- SECURITY DEFINER function via LATERAL join. Post/comment/DM visibility still
-- runs under the caller's RLS (security_invoker on the views); only the handle
-- lookup bypasses RLS, and it returns no identifying data (never user_id).

begin;

create or replace function public.nexus_handle_public(p_community uuid, p_user uuid)
returns table(token uuid, handle text, avatar_seed text)
language sql security definer stable set search_path = public as $$
  select token, handle, avatar_seed
  from public.nexus_anonymous_handles
  where community_id = p_community and user_id = p_user;
$$;
grant execute on function public.nexus_handle_public(uuid, uuid) to anon, authenticated;

create or replace view public.nexus_posts_view with (security_invoker = true) as
  select p.id, p.community_id, p.is_ai_author, p.title, p.body, p.image_url,
         p.impact_count, p.comment_count, p.created_at, p.updated_at,
         hp.token                  as author_token,
         coalesce(hp.handle, '')    as author_handle,
         coalesce(hp.avatar_seed,'') as avatar_seed,
         coalesce(p.author_user_id = auth.uid(), false) as is_mine,
         exists (select 1 from public.nexus_impacts i
                 where i.post_id = p.id and i.user_id = auth.uid()
                   and i.impact_type = 'resonated') as my_resonated
  from public.nexus_posts p
  left join lateral public.nexus_handle_public(p.community_id, p.author_user_id) hp on true
  where p.is_soft_hidden = false;
grant select on public.nexus_posts_view to anon, authenticated;

create or replace view public.nexus_comments_view with (security_invoker = true) as
  select c.id, c.post_id, c.is_ai_author, c.body, c.image_url, c.created_at,
         hp.token                   as author_token,
         coalesce(hp.handle, '')     as author_handle,
         coalesce(hp.avatar_seed, '') as avatar_seed,
         coalesce(c.author_user_id = auth.uid(), false) as is_mine
  from public.nexus_comments c
  join public.nexus_posts p on p.id = c.post_id
  left join lateral public.nexus_handle_public(p.community_id, c.author_user_id) hp on true
  where c.is_soft_hidden = false;
grant select on public.nexus_comments_view to anon, authenticated;

create or replace view public.nexus_dm_messages_view with (security_invoker = true) as
  select d.id, d.community_id, d.body, d.image_url, d.created_at,
         coalesce(d.sender_user_id = auth.uid(), false) as is_mine,
         case when d.sender_user_id = auth.uid() then hr.token else hs.token end as other_token,
         case when d.sender_user_id = auth.uid()
              then coalesce(hr.handle, '') else coalesce(hs.handle, '') end as other_handle
  from public.nexus_dm_messages d
  left join lateral public.nexus_handle_public(d.community_id, d.sender_user_id) hs on true
  left join lateral public.nexus_handle_public(d.community_id, d.recipient_user_id) hr on true
  where d.sender_user_id = auth.uid() or d.recipient_user_id = auth.uid();
grant select on public.nexus_dm_messages_view to authenticated;

commit;
