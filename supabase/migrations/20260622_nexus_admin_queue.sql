-- Nexus — moderator/admin review queue (NEXUS-GAPS.md Phase 1, #7).
-- Reuses the existing public.is_admin() gate. Surfaces open reports + lets an admin
-- hide the reported content or dismiss the report.

begin;

create or replace function public.nexus_admin_reports()
returns table(id uuid, target_type text, target_id uuid, reported_handle text,
              community_id uuid, reason text, details text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select r.id, r.target_type, r.target_id,
           coalesce((select h.handle from public.nexus_anonymous_handles h
                       where h.user_id = r.reported_user_id and h.community_id = r.community_id limit 1), '—'),
           r.community_id, r.reason, r.details, r.created_at
    from public.nexus_reports r
    where r.status = 'open'
    order by r.created_at desc
    limit 200;
end;
$$;
grant execute on function public.nexus_admin_reports() to authenticated;

create or replace function public.nexus_admin_resolve(p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.nexus_reports where id = p_id;
  if not found then return; end if;
  if p_action = 'hide' then
    if r.target_type = 'post' then
      update public.nexus_posts set is_soft_hidden = true where id = r.target_id;
    elsif r.target_type = 'comment' then
      update public.nexus_comments set is_soft_hidden = true where id = r.target_id;
    end if;
    update public.nexus_reports set status = 'actioned' where id = p_id;
  elsif p_action = 'dismiss' then
    update public.nexus_reports set status = 'dismissed' where id = p_id;
  else
    update public.nexus_reports set status = 'reviewing' where id = p_id;
  end if;
end;
$$;
grant execute on function public.nexus_admin_resolve(uuid, text) to authenticated;

commit;
