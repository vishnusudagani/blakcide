-- Close a privilege-escalation hole: the "Users can update own profile" RLS policy
-- lets any authenticated user UPDATE their own profiles row with no column guard,
-- so they could set role='admin' and reach /beta/admin. This trigger keeps `role`
-- immutable for normal callers; only service_role or an already-admin caller may
-- change it (admin RPCs run SECURITY DEFINER but carry the caller's JWT, so the
-- admin-role check covers them). Applied live to T2MWEB 2026-06-25.
create or replace function public.guard_profiles_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if coalesce(auth.role(), '') <> 'service_role'
       and coalesce((select p.role from public.profiles p where p.id = auth.uid()), '') <> 'admin' then
      new.role := old.role;   -- silently keep the existing role; no escalation
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profiles_role on public.profiles;
create trigger guard_profiles_role
  before update on public.profiles
  for each row execute function public.guard_profiles_role();
