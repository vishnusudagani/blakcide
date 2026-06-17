-- Nexus — nexus_create_tribe RPC.
-- Was applied ad-hoc to the live DB (T2MWEB) and was missing from source control;
-- captured here so a rebuilt/preview DB has it. Creates a public community with a
-- unique slug and makes the caller its first member (moderator). Sign-in required.
create or replace function public.nexus_create_tribe(p_name text, p_description text default null)
returns public.nexus_communities
language plpgsql security definer set search_path = public as $$
declare
  c public.nexus_communities;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Untitled tribe'), 60);
  v_base text := nullif(trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')), '');
  v_slug text;
  i int := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create a tribe.' using errcode = '42501';
  end if;
  v_base := coalesce(v_base, 'tribe');
  v_slug := v_base;
  while exists (select 1 from public.nexus_communities where slug = v_slug) loop
    i := i + 1;
    v_slug := v_base || '-' || i;
  end loop;
  insert into public.nexus_communities (name, slug, description, visibility)
  values (v_name, v_slug, nullif(trim(p_description), ''), 'public')
  returning * into c;
  insert into public.nexus_community_members (community_id, user_id, role)
  values (c.id, auth.uid(), 'moderator');
  return c;
end $$;
grant execute on function public.nexus_create_tribe(text, text) to authenticated;
