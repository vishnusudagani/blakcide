-- Nexus — tribe visibility: public / private / anonymous (NEXUS-GAPS.md Phase 3, #28).
-- Non-public tribes are excluded from discovery (loadTribes filters visibility='public')
-- and the existing nexus_communities_read policy already gates them to members only.
begin;
alter table public.nexus_communities drop constraint if exists nexus_communities_visibility_check;
alter table public.nexus_communities add constraint nexus_communities_visibility_check
  check (visibility in ('public','members_only','private','anonymous'));

drop function if exists public.nexus_create_tribe(text, text);
create or replace function public.nexus_create_tribe(p_name text, p_description text default null, p_visibility text default 'public')
returns public.nexus_communities
language plpgsql security definer set search_path = public as $$
declare
  c public.nexus_communities;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Untitled tribe'), 60);
  v_base text := nullif(trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')), '');
  v_slug text; i int := 0;
  v_vis text := case when p_visibility in ('public','private','anonymous') then p_visibility else 'public' end;
begin
  if auth.uid() is null then raise exception 'Sign in to create a tribe.' using errcode = '42501'; end if;
  v_base := coalesce(v_base, 'tribe'); v_slug := v_base;
  while exists (select 1 from public.nexus_communities where slug = v_slug) loop
    i := i + 1; v_slug := v_base || '-' || i;
  end loop;
  insert into public.nexus_communities (name, slug, description, visibility)
  values (v_name, v_slug, nullif(trim(p_description), ''), v_vis)
  returning * into c;
  insert into public.nexus_community_members (community_id, user_id, role)
  values (c.id, auth.uid(), 'moderator');
  perform public._nexus_mint_handle(c.id, auth.uid());
  return c;
end $$;
grant execute on function public.nexus_create_tribe(text, text, text) to authenticated;
commit;
