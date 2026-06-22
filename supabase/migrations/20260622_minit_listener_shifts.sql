-- Phase 4 (#2/#3): listener shift calendar + coverage gaps. Listeners claim
-- recurring weekly availability blocks (weekday 0-6 × 6 four-hour blocks); the
-- console shows where coverage across ALL listeners is thin, so they fill gaps.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
create table if not exists public.listener_shifts (
  id          uuid primary key default gen_random_uuid(),
  listener_id uuid not null references public.listeners(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  block       smallint not null check (block between 0 and 5),
  created_at  timestamptz not null default now(),
  unique (listener_id, weekday, block)
);
alter table public.listener_shifts enable row level security;

drop policy if exists ls_owner on public.listener_shifts;
create policy ls_owner on public.listener_shifts for all to authenticated
  using (listener_id in (select id from public.listeners where user_id = auth.uid()))
  with check (listener_id in (select id from public.listeners where user_id = auth.uid()));

-- Cross-listener coverage + the caller's own slots, in one call (slot = weekday*10+block).
create or replace function public.minit_shift_grid()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lid uuid; v_mine jsonb; v_cov jsonb;
begin
  select id into v_lid from public.listeners where user_id = auth.uid();
  if v_lid is null then return jsonb_build_object('listener', false); end if;
  select coalesce(jsonb_agg(weekday * 10 + block), '[]'::jsonb) into v_mine
    from public.listener_shifts where listener_id = v_lid;
  select coalesce(jsonb_object_agg(slot, n), '{}'::jsonb) into v_cov from (
    select (weekday * 10 + block)::text as slot, count(distinct listener_id) as n
    from public.listener_shifts group by 1
  ) t;
  return jsonb_build_object('listener', true, 'mine', v_mine, 'coverage', v_cov);
end $$;
revoke all on function public.minit_shift_grid() from public, anon;
grant execute on function public.minit_shift_grid() to authenticated;
