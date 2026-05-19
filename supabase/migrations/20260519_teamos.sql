-- Team OS — minimal schema (prefixed teamos_ to coexist with the Symp tables).
-- Phase 1 of the Supabase port: profiles + tasks + RLS + updated_at triggers.
-- Phase 2 will add roadmaps, milestones, goals, comments, etc.

-- ─── 1. Profiles (extends auth.users) ──────────────────────────────────
create table if not exists public.teamos_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  full_name text not null,
  role text not null default 'employee' check (role in ('owner', 'coo', 'employee')),
  department text,
  avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists teamos_profiles_role_idx on public.teamos_profiles (role);

-- ─── 2. Tasks ─────────────────────────────────────────────────────────
create table if not exists public.teamos_tasks (
  id bigserial primary key,
  title text not null,
  description text,
  status text not null default 'todo' check (status in ('todo','in_progress','review','completed')),
  priority text not null default 'medium' check (priority in ('critical','high','medium','low')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete cascade,
  due_date timestamptz,
  completion_percent int default 0,
  quality_score numeric,
  tags jsonb default '[]'::jsonb,
  order_index int default 0,
  attachments jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists teamos_tasks_assigned_idx on public.teamos_tasks (assigned_to);
create index if not exists teamos_tasks_created_by_idx on public.teamos_tasks (created_by);
create index if not exists teamos_tasks_status_idx on public.teamos_tasks (status);

-- ─── 3. RLS ──────────────────────────────────────────────────────────
alter table public.teamos_profiles enable row level security;
alter table public.teamos_tasks    enable row level security;

-- helper: what's my role?
create or replace function public.teamos_my_role()
returns text language sql security definer set search_path = public as $$
  select role from public.teamos_profiles where id = auth.uid()
$$;

-- profiles policies
drop policy if exists "teamos_profiles_select" on public.teamos_profiles;
create policy "teamos_profiles_select" on public.teamos_profiles
  for select to authenticated using (true);

drop policy if exists "teamos_profiles_update_own" on public.teamos_profiles;
create policy "teamos_profiles_update_own" on public.teamos_profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "teamos_profiles_owner_all" on public.teamos_profiles;
create policy "teamos_profiles_owner_all" on public.teamos_profiles
  for all to authenticated
  using (public.teamos_my_role() = 'owner')
  with check (public.teamos_my_role() = 'owner');

-- tasks policies (employees see assigned/created; coo+ see all)
drop policy if exists "teamos_tasks_select" on public.teamos_tasks;
create policy "teamos_tasks_select" on public.teamos_tasks
  for select to authenticated using (
    public.teamos_my_role() in ('owner','coo')
    or assigned_to = auth.uid()
    or created_by = auth.uid()
  );

drop policy if exists "teamos_tasks_insert" on public.teamos_tasks;
create policy "teamos_tasks_insert" on public.teamos_tasks
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "teamos_tasks_update" on public.teamos_tasks;
create policy "teamos_tasks_update" on public.teamos_tasks
  for update to authenticated using (
    public.teamos_my_role() in ('owner','coo')
    or assigned_to = auth.uid()
    or created_by = auth.uid()
  );

drop policy if exists "teamos_tasks_delete" on public.teamos_tasks;
create policy "teamos_tasks_delete" on public.teamos_tasks
  for delete to authenticated using (
    public.teamos_my_role() in ('owner','coo')
    or created_by = auth.uid()
  );

-- ─── 4. updated_at trigger ───────────────────────────────────────────
create or replace function public.teamos_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists teamos_profiles_set_updated on public.teamos_profiles;
create trigger teamos_profiles_set_updated before update on public.teamos_profiles
  for each row execute function public.teamos_set_updated_at();

drop trigger if exists teamos_tasks_set_updated on public.teamos_tasks;
create trigger teamos_tasks_set_updated before update on public.teamos_tasks
  for each row execute function public.teamos_set_updated_at();

-- ─── 5. Realtime publish (so the UI can subscribe to changes) ────────
alter publication supabase_realtime add table public.teamos_tasks;
