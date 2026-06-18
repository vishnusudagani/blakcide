-- Minit — Phase 3b: Listener Discovery directory.
--
-- Browse listeners (Connect mode L4). listeners_public was switched to
-- security_invoker (own-row only), so the directory is exposed via this curated
-- SECURITY DEFINER RPC: safe fields only (no user_id), available listeners first.
-- Additive — no existing behaviour changes.

create or replace function public.minit_list_listeners()
returns table (id uuid, display_name text, profile_pic text, bio text, style text,
               languages text[], specialties text[], gender text, rating numeric,
               reviews_count integer, status text)
language sql security definer stable set search_path = public as $$
  select l.id, l.display_name, l.profile_pic, l.bio, l.style, l.languages, l.specialties,
         l.gender, l.rating, l.reviews_count,
         case
           when not coalesce(l.is_online, false)
             or (l.last_seen is not null and l.last_seen < now() - interval '120 seconds') then 'offline'
           when exists (select 1 from public.connect_sessions s
                        where s.listener_id = l.id and s.status in ('active', 'pending')) then 'busy'
           else 'available'
         end as status
  from public.listeners l
  order by
    (case when coalesce(l.is_online, false)
          and (l.last_seen is null or l.last_seen > now() - interval '120 seconds') then 0 else 1 end),
    l.rating desc nulls last, l.reviews_count desc nulls last, l.display_name asc;
$$;
grant execute on function public.minit_list_listeners() to authenticated;
revoke execute on function public.minit_list_listeners() from public;
