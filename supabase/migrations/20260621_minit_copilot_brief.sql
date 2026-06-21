-- Minit co-pilot brief — Phase 1 of the 50-gap buildout.
-- "Context, not content": Blak briefs the listener on the SHAPE of the
-- conversation, the seeker approves it before connecting, and the listener's
-- post-session note feeds back into Blak (abstracted). Builds on existing
-- symp_listener_briefs + minit_listener_notes.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)

-- 1. Let the SEEKER (owner) store the brief they approved for their own session.
--    (Existing policy only allowed listener/seeker SELECT; inserts were service-side.)
drop policy if exists briefs_owner_write on public.symp_listener_briefs;
create policy briefs_owner_write on public.symp_listener_briefs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.connect_sessions s
      where s.id = connect_session_id and s.user_id = auth.uid()
    )
  );

drop policy if exists briefs_owner_update on public.symp_listener_briefs;
create policy briefs_owner_update on public.symp_listener_briefs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 2. Structure the listener's post-session note (was free-text only).
alter table public.minit_listener_notes
  add column if not exists shape text,
  add column if not exists tags  text[];

-- 3. Write-back: the matched listener leaves a short "shape" note → it's stored
--    AND distilled into the seeker's knowledge profile (source='minit',
--    sensitive, abstracted — never the content verbatim). SECURITY DEFINER so a
--    listener can write into the seeker's owner-RLS knowledge, but ONLY for a
--    session they actually own.
create or replace function public.minit_brief_writeback(
  p_session uuid,
  p_note    text,
  p_shape   text   default null,
  p_tags    text[] default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_seeker   uuid;
  v_listener uuid;
begin
  select user_id, listener_id into v_seeker, v_listener
    from public.connect_sessions where id = p_session;

  if v_listener is null or v_listener <> auth.uid() then
    raise exception 'not your session';
  end if;

  insert into public.minit_listener_notes (session_id, listener_user_id, notes, shape, tags, updated_at)
    values (p_session, auth.uid(), p_note, p_shape, p_tags, now())
  on conflict (session_id) do update
    set notes = coalesce(excluded.notes, public.minit_listener_notes.notes),
        shape = coalesce(excluded.shape, public.minit_listener_notes.shape),
        tags  = coalesce(excluded.tags,  public.minit_listener_notes.tags),
        updated_at = now();

  -- Feed Blak — abstracted shape only.
  if v_seeker is not null and coalesce(p_shape, '') <> '' then
    perform public.knowledge_upsert(
      v_seeker, 'inner', 'minit:listener_shape',
      'How a listener experienced you', p_shape, 'minit', true, 0.5,
      'Abstracted from a Minit listener''s post-session note'
    );
  end if;
end $$;

revoke all on function public.minit_brief_writeback(uuid, text, text, text[]) from public, anon;
grant execute on function public.minit_brief_writeback(uuid, text, text, text[]) to authenticated;
