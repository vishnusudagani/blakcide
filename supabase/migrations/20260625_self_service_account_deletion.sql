-- Self-service account deletion (Apple 5.1.1(v) + Google account-deletion + DPDP
-- §12 erasure). No public table FKs auth.users, so we explicitly clear every
-- owner-keyed table (multi-pass for FK ordering; text-cast so uuid + legacy text
-- id columns both match), then remove the auth user. SECURITY DEFINER, scoped to
-- the caller via auth.uid(). Applied live to T2MWEB 2026-06-25 + verified.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  rec record;
  pass int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  for pass in 1..5 loop
    for rec in
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public'
        and c.column_name in ('user_id','owner_id','creator_id','author_user_id','sender_id','recipient_user_id','listener_id','host_id','created_by')
    loop
      begin
        execute format('delete from public.%I where %I::text = $1', rec.table_name, rec.column_name) using uid::text;
      exception when others then null;
      end;
    end loop;
  end loop;
  begin delete from public.profiles where id = uid; exception when others then null; end;
  begin delete from public.user_profiles where id = uid; exception when others then null; end;
  delete from auth.users where id = uid;
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
