-- Team OS Phase 2 — full schema for the remaining domains.
-- Tables: goals, roadmaps, milestones, events, comments, attachments,
-- time_entries, checklist, contacts, daily_updates, discussion,
-- notifications, audit_log, saved_views.
-- Also extends teamos_tasks with goal/roadmap/milestone foreign keys.

-- ─── 1. GOALS ──────────────────────────────────────────────────────────
create table if not exists public.teamos_goals (
  id bigserial primary key,
  title text not null,
  description text,
  status text not null default 'active' check (status in ('active','achieved','paused','dropped')),
  target_date timestamptz,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── 2. ROADMAPS ───────────────────────────────────────────────────────
create table if not exists public.teamos_roadmaps (
  id bigserial primary key,
  name text not null,
  description text,
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','completed','archived')),
  color text default 'indigo',
  goal_id bigint references public.teamos_goals(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── 3. MILESTONES ─────────────────────────────────────────────────────
create table if not exists public.teamos_milestones (
  id bigserial primary key,
  roadmap_id bigint not null references public.teamos_roadmaps(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'planned' check (status in ('planned','in_progress','completed')),
  target_date timestamptz,
  order_index int default 0,
  created_at timestamptz default now()
);

-- ─── 4. Extend teamos_tasks with new FKs ───────────────────────────────
alter table public.teamos_tasks add column if not exists goal_id     bigint references public.teamos_goals(id)     on delete set null;
alter table public.teamos_tasks add column if not exists roadmap_id  bigint references public.teamos_roadmaps(id)  on delete set null;
alter table public.teamos_tasks add column if not exists milestone_id bigint references public.teamos_milestones(id) on delete set null;

-- ─── 5. EVENTS (schedule) ──────────────────────────────────────────────
create table if not exists public.teamos_events (
  id bigserial primary key,
  title text not null,
  description text,
  type text not null default 'meeting' check (type in ('meeting','call','reminder','focus')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  location text,
  attendee_ids uuid[] default '{}'::uuid[],
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint event_end_after_start check (end_at > start_at)
);

-- ─── 6. COMMENTS (on tasks) ────────────────────────────────────────────
create table if not exists public.teamos_comments (
  id bigserial primary key,
  task_id bigint not null references public.teamos_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

-- ─── 7. ATTACHMENTS (DB row pointing at a Storage path) ────────────────
create table if not exists public.teamos_attachments (
  id bigserial primary key,
  task_id bigint not null references public.teamos_tasks(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  size_bytes int default 0,
  storage_path text not null,    -- inside the teamos-attachments bucket
  created_at timestamptz default now()
);

-- ─── 8. TIME ENTRIES ───────────────────────────────────────────────────
create table if not exists public.teamos_time_entries (
  id bigserial primary key,
  task_id bigint not null references public.teamos_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  minutes int not null check (minutes > 0 and minutes <= 1440),
  note text,
  logged_at timestamptz default now()
);

-- ─── 9. CHECKLIST (personal todos) ─────────────────────────────────────
create table if not exists public.teamos_checklist (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  done boolean default false,
  order_index int default 0,
  done_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── 10. CONTACTS (CRM) ────────────────────────────────────────────────
create table if not exists public.teamos_contacts (
  id bigserial primary key,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null,
  number text,
  age int,
  gender text,
  profession text,
  location text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── 11. DAILY UPDATES (standups) ──────────────────────────────────────
create table if not exists public.teamos_daily_updates (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date default current_date,
  summary text not null,
  blockers text,
  tomorrow_plan text,
  mood text,
  created_at timestamptz default now()
);

-- ─── 12. DISCUSSION (team-wide chat) ───────────────────────────────────
create table if not exists public.teamos_discussion (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

-- ─── 13. NOTIFICATIONS ─────────────────────────────────────────────────
create table if not exists public.teamos_notifications (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  message text not null,
  ref_kind text,
  ref_id bigint,
  actor_id uuid references auth.users(id) on delete set null,
  read boolean default false,
  created_at timestamptz default now()
);
create index if not exists teamos_notif_user_idx on public.teamos_notifications (user_id, read);

-- ─── 14. AUDIT LOG ─────────────────────────────────────────────────────
create table if not exists public.teamos_audit_log (
  id bigserial primary key,
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  ref_kind text not null,
  ref_id bigint not null,
  summary text,
  payload jsonb,
  created_at timestamptz default now()
);
create index if not exists teamos_audit_kind_idx on public.teamos_audit_log (ref_kind, ref_id);

-- ─── 15. SAVED VIEWS ───────────────────────────────────────────────────
create table if not exists public.teamos_saved_views (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  page text default 'tasks',
  filters jsonb default '{}'::jsonb,
  is_default boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ═══════════════════════════════════════════════════════════════════════
-- RLS — enable + policies
-- ═══════════════════════════════════════════════════════════════════════
alter table public.teamos_goals          enable row level security;
alter table public.teamos_roadmaps       enable row level security;
alter table public.teamos_milestones     enable row level security;
alter table public.teamos_events         enable row level security;
alter table public.teamos_comments       enable row level security;
alter table public.teamos_attachments    enable row level security;
alter table public.teamos_time_entries   enable row level security;
alter table public.teamos_checklist      enable row level security;
alter table public.teamos_contacts       enable row level security;
alter table public.teamos_daily_updates  enable row level security;
alter table public.teamos_discussion     enable row level security;
alter table public.teamos_notifications  enable row level security;
alter table public.teamos_audit_log      enable row level security;
alter table public.teamos_saved_views    enable row level security;

-- Helper that already exists from phase 1: public.teamos_my_role()

-- Task-visibility helper for sub-resources (comments, attachments, time entries)
create or replace function public.teamos_can_view_task(p_task_id bigint)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.teamos_tasks t
    where t.id = p_task_id
      and (
        public.teamos_my_role() in ('owner','coo')
        or t.assigned_to = auth.uid()
        or t.created_by = auth.uid()
      )
  )
$$;

-- ── GOALS: everyone reads, coo+ writes ──
drop policy if exists "teamos_goals_select" on public.teamos_goals;
create policy "teamos_goals_select" on public.teamos_goals for select to authenticated using (true);
drop policy if exists "teamos_goals_write" on public.teamos_goals;
create policy "teamos_goals_write" on public.teamos_goals for all to authenticated
  using (public.teamos_my_role() in ('owner','coo'))
  with check (public.teamos_my_role() in ('owner','coo'));

-- ── ROADMAPS: everyone reads, coo+ writes ──
drop policy if exists "teamos_roadmaps_select" on public.teamos_roadmaps;
create policy "teamos_roadmaps_select" on public.teamos_roadmaps for select to authenticated using (true);
drop policy if exists "teamos_roadmaps_write" on public.teamos_roadmaps;
create policy "teamos_roadmaps_write" on public.teamos_roadmaps for all to authenticated
  using (public.teamos_my_role() in ('owner','coo'))
  with check (public.teamos_my_role() in ('owner','coo'));

-- ── MILESTONES: same as roadmaps ──
drop policy if exists "teamos_milestones_select" on public.teamos_milestones;
create policy "teamos_milestones_select" on public.teamos_milestones for select to authenticated using (true);
drop policy if exists "teamos_milestones_write" on public.teamos_milestones;
create policy "teamos_milestones_write" on public.teamos_milestones for all to authenticated
  using (public.teamos_my_role() in ('owner','coo'))
  with check (public.teamos_my_role() in ('owner','coo'));

-- ── EVENTS: everyone reads + creates own, creator/coo+ modifies ──
drop policy if exists "teamos_events_select" on public.teamos_events;
create policy "teamos_events_select" on public.teamos_events for select to authenticated using (true);
drop policy if exists "teamos_events_insert" on public.teamos_events;
create policy "teamos_events_insert" on public.teamos_events for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "teamos_events_modify" on public.teamos_events;
create policy "teamos_events_modify" on public.teamos_events for update to authenticated
  using (created_by = auth.uid() or public.teamos_my_role() in ('owner','coo'));
drop policy if exists "teamos_events_delete" on public.teamos_events;
create policy "teamos_events_delete" on public.teamos_events for delete to authenticated
  using (created_by = auth.uid() or public.teamos_my_role() in ('owner','coo'));

-- ── COMMENTS: visibility tied to task ──
drop policy if exists "teamos_comments_select" on public.teamos_comments;
create policy "teamos_comments_select" on public.teamos_comments for select to authenticated using (public.teamos_can_view_task(task_id));
drop policy if exists "teamos_comments_insert" on public.teamos_comments;
create policy "teamos_comments_insert" on public.teamos_comments for insert to authenticated with check (user_id = auth.uid() and public.teamos_can_view_task(task_id));
drop policy if exists "teamos_comments_delete" on public.teamos_comments;
create policy "teamos_comments_delete" on public.teamos_comments for delete to authenticated using (user_id = auth.uid() or public.teamos_my_role() in ('owner','coo'));

-- ── ATTACHMENTS (DB rows): visibility tied to task ──
drop policy if exists "teamos_attachments_select" on public.teamos_attachments;
create policy "teamos_attachments_select" on public.teamos_attachments for select to authenticated using (public.teamos_can_view_task(task_id));
drop policy if exists "teamos_attachments_insert" on public.teamos_attachments;
create policy "teamos_attachments_insert" on public.teamos_attachments for insert to authenticated with check (uploaded_by = auth.uid() and public.teamos_can_view_task(task_id));
drop policy if exists "teamos_attachments_delete" on public.teamos_attachments;
create policy "teamos_attachments_delete" on public.teamos_attachments for delete to authenticated using (uploaded_by = auth.uid() or public.teamos_my_role() in ('owner','coo'));

-- ── TIME ENTRIES ──
drop policy if exists "teamos_time_select" on public.teamos_time_entries;
create policy "teamos_time_select" on public.teamos_time_entries for select to authenticated using (
  user_id = auth.uid() or public.teamos_can_view_task(task_id) or public.teamos_my_role() in ('owner','coo')
);
drop policy if exists "teamos_time_insert" on public.teamos_time_entries;
create policy "teamos_time_insert" on public.teamos_time_entries for insert to authenticated with check (user_id = auth.uid() and public.teamos_can_view_task(task_id));
drop policy if exists "teamos_time_delete" on public.teamos_time_entries;
create policy "teamos_time_delete" on public.teamos_time_entries for delete to authenticated using (user_id = auth.uid() or public.teamos_my_role() in ('owner','coo'));

-- ── CHECKLIST: strictly private to the owner ──
drop policy if exists "teamos_checklist_all" on public.teamos_checklist;
create policy "teamos_checklist_all" on public.teamos_checklist for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── CONTACTS: own + owner ──
drop policy if exists "teamos_contacts_select" on public.teamos_contacts;
create policy "teamos_contacts_select" on public.teamos_contacts for select to authenticated
  using (created_by = auth.uid() or public.teamos_my_role() = 'owner');
drop policy if exists "teamos_contacts_insert" on public.teamos_contacts;
create policy "teamos_contacts_insert" on public.teamos_contacts for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "teamos_contacts_modify" on public.teamos_contacts;
create policy "teamos_contacts_modify" on public.teamos_contacts for update to authenticated
  using (created_by = auth.uid() or public.teamos_my_role() = 'owner');
drop policy if exists "teamos_contacts_delete" on public.teamos_contacts;
create policy "teamos_contacts_delete" on public.teamos_contacts for delete to authenticated
  using (created_by = auth.uid() or public.teamos_my_role() = 'owner');

-- ── DAILY UPDATES: own writes, coo+ reads all ──
drop policy if exists "teamos_du_select" on public.teamos_daily_updates;
create policy "teamos_du_select" on public.teamos_daily_updates for select to authenticated
  using (user_id = auth.uid() or public.teamos_my_role() in ('owner','coo'));
drop policy if exists "teamos_du_insert" on public.teamos_daily_updates;
create policy "teamos_du_insert" on public.teamos_daily_updates for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "teamos_du_delete" on public.teamos_daily_updates;
create policy "teamos_du_delete" on public.teamos_daily_updates for delete to authenticated using (user_id = auth.uid());

-- ── DISCUSSION: team-wide read/write ──
drop policy if exists "teamos_disc_select" on public.teamos_discussion;
create policy "teamos_disc_select" on public.teamos_discussion for select to authenticated using (true);
drop policy if exists "teamos_disc_insert" on public.teamos_discussion;
create policy "teamos_disc_insert" on public.teamos_discussion for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "teamos_disc_delete" on public.teamos_discussion;
create policy "teamos_disc_delete" on public.teamos_discussion for delete to authenticated using (user_id = auth.uid() or public.teamos_my_role() in ('owner','coo'));

-- ── NOTIFICATIONS: own only ──
drop policy if exists "teamos_notif_all" on public.teamos_notifications;
create policy "teamos_notif_all" on public.teamos_notifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── AUDIT LOG: coo+ reads, anyone (authenticated) writes via service-side helpers ──
-- We let everyone insert (client logs their own actions); read is restricted.
drop policy if exists "teamos_audit_insert" on public.teamos_audit_log;
create policy "teamos_audit_insert" on public.teamos_audit_log for insert to authenticated with check (actor_id = auth.uid());
drop policy if exists "teamos_audit_select" on public.teamos_audit_log;
create policy "teamos_audit_select" on public.teamos_audit_log for select to authenticated
  using (public.teamos_my_role() in ('owner','coo') or actor_id = auth.uid());

-- ── SAVED VIEWS: own only ──
drop policy if exists "teamos_views_all" on public.teamos_saved_views;
create policy "teamos_views_all" on public.teamos_saved_views for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════
-- updated_at triggers
-- ═══════════════════════════════════════════════════════════════════════
do $$ begin
  perform 1 from pg_proc where proname = 'teamos_set_updated_at';
exception when others then null;
end $$;

drop trigger if exists teamos_goals_set_updated on public.teamos_goals;
create trigger teamos_goals_set_updated before update on public.teamos_goals for each row execute function public.teamos_set_updated_at();

drop trigger if exists teamos_roadmaps_set_updated on public.teamos_roadmaps;
create trigger teamos_roadmaps_set_updated before update on public.teamos_roadmaps for each row execute function public.teamos_set_updated_at();

drop trigger if exists teamos_events_set_updated on public.teamos_events;
create trigger teamos_events_set_updated before update on public.teamos_events for each row execute function public.teamos_set_updated_at();

drop trigger if exists teamos_contacts_set_updated on public.teamos_contacts;
create trigger teamos_contacts_set_updated before update on public.teamos_contacts for each row execute function public.teamos_set_updated_at();

drop trigger if exists teamos_checklist_set_updated on public.teamos_checklist;
create trigger teamos_checklist_set_updated before update on public.teamos_checklist for each row execute function public.teamos_set_updated_at();

drop trigger if exists teamos_views_set_updated on public.teamos_saved_views;
create trigger teamos_views_set_updated before update on public.teamos_saved_views for each row execute function public.teamos_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- Realtime publish
-- ═══════════════════════════════════════════════════════════════════════
alter publication supabase_realtime add table public.teamos_comments;
alter publication supabase_realtime add table public.teamos_notifications;
alter publication supabase_realtime add table public.teamos_discussion;
