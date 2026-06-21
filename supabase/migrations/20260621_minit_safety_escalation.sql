-- Phase 3 (two-sided safety): senior-listener escalation. A listener facing an
-- imminent-harm moment raises it → recorded for seniors AND the session is flagged
-- (so it surfaces in the existing moderation view). No clinical/govt-helpline framing.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)

alter table public.listeners add column if not exists is_senior boolean not null default false;

create table if not exists public.minit_escalations (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.connect_sessions(id) on delete cascade,
  raised_by   uuid not null,
  note        text,
  status      text not null default 'open' check (status in ('open', 'handled')),
  created_at  timestamptz not null default now(),
  handled_by  uuid,
  handled_at  timestamptz
);
create index if not exists idx_escalations_open on public.minit_escalations (status, created_at desc);
alter table public.minit_escalations enable row level security;

drop policy if exists esc_select on public.minit_escalations;
create policy esc_select on public.minit_escalations for select to authenticated
  using (raised_by = auth.uid()
         or exists (select 1 from public.listeners l where l.user_id = auth.uid() and l.is_senior));
drop policy if exists esc_update on public.minit_escalations;
create policy esc_update on public.minit_escalations for update to authenticated
  using (exists (select 1 from public.listeners l where l.user_id = auth.uid() and l.is_senior))
  with check (exists (select 1 from public.listeners l where l.user_id = auth.uid() and l.is_senior));

create or replace function public.minit_escalate(p_session uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_listener uuid;
begin
  select listener_id into v_listener from public.connect_sessions where id = p_session;
  if v_listener is null or v_listener <> auth.uid() then
    raise exception 'not your session';
  end if;
  insert into public.minit_escalations (session_id, raised_by, note)
    values (p_session, auth.uid(), p_note);
  update public.connect_sessions
    set flagged_at = coalesce(flagged_at, now()), flag_reason = 'escalated'
    where id = p_session;
end $$;
revoke all on function public.minit_escalate(uuid, text) from public, anon;
grant execute on function public.minit_escalate(uuid, text) to authenticated;
