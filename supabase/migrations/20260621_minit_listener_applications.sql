-- Phase 4 (supply): the listener funnel — apply → screen → train → certify.
-- Applicants self-serve; the admin screens & certifies, which provisions a listener.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)

create table if not exists public.listener_applications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  display_name text not null,
  languages    text[] not null default '{}',
  specialties  text[] not null default '{}',
  gender       text,
  blurb        text,
  why          text,
  screening    jsonb,
  agreed       boolean not null default false,
  status       text not null default 'applied' check (status in ('applied', 'screening', 'certified', 'rejected')),
  created_at   timestamptz not null default now(),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  review_note  text
);
create unique index if not exists uniq_listener_app_open on public.listener_applications (user_id) where status in ('applied', 'screening');
alter table public.listener_applications enable row level security;

drop policy if exists la_insert on public.listener_applications;
create policy la_insert on public.listener_applications for insert to authenticated with check (user_id = auth.uid());
drop policy if exists la_select_own on public.listener_applications;
create policy la_select_own on public.listener_applications for select to authenticated using (user_id = auth.uid());

create or replace function public.minit_admin_applications()
returns setof public.listener_applications language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query select * from public.listener_applications where status in ('applied', 'screening') order by created_at asc;
end $$;

create or replace function public.minit_admin_review_application(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a public.listener_applications;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select * into a from public.listener_applications where id = p_id;
  if not found then raise exception 'no such application'; end if;
  if p_approve then
    if not exists (select 1 from public.listeners where user_id = a.user_id) then
      insert into public.listeners (user_id, display_name, languages, specialties, gender, bio, is_online, rating, reviews_count, chat_price_per_min, call_price_per_min)
      values (a.user_id, a.display_name, coalesce(a.languages, '{}'), coalesce(a.specialties, '{}'), a.gender, a.blurb, false, 5, 0, 0, 0);
    end if;
    update public.listener_applications set status = 'certified', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note where id = p_id;
  else
    update public.listener_applications set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note where id = p_id;
  end if;
end $$;

revoke all on function public.minit_admin_applications() from public, anon;
revoke all on function public.minit_admin_review_application(uuid, boolean, text) from public, anon;
grant execute on function public.minit_admin_applications() to authenticated;
grant execute on function public.minit_admin_review_application(uuid, boolean, text) to authenticated;
