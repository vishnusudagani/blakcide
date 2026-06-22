-- Nexus — crisis classification + response (NEXUS-GAPS.md Phase 1, #4/#5).
--
-- Tier 1 (this migration): a deterministic, multilingual LEXICAL classifier that
-- runs as a BEFORE INSERT trigger on posts + comments — so it fires on EVERY write
-- (legacy direct insert AND the proxy RPCs), protecting users immediately, even
-- before the proxy cutover. A 'critical' hit is soft-hidden from the public feed on
-- the way in; an AFTER trigger records a crisis event so the author privately gets a
-- Listener (Minit) hand-off + helplines. Triggers are exception-guarded — a
-- classifier hiccup can never block a post.
--
-- Tier 2 (follow-up): an edge function (`nexus-crisis`) gives elevated/ambiguous
-- posts an LLM second opinion via the multi-provider router, upgrading risk + firing
-- the same response. Not in this migration.
--
-- Patterns are intentionally conservative for 'critical' (explicit self-harm/suicide
-- intent only) to limit false positives; the response is gentle, never punitive.

begin;

-- ── Tier 1: lexical classifier (English + romanized Telugu/Hindi) ───────────
-- Postgres regex: \y = word boundary (NOT \b, which is backspace here).
create or replace function public.nexus_crisis_lexical(p_text text)
returns text language plpgsql immutable set search_path = public as $$
declare t text := lower(coalesce(p_text, ''));
begin
  if t = '' then return 'normal'; end if;

  if t ~ '\y(kill|killing)\s+myself\y'
     or t ~ '\yend(ing)?\s+(my\s+)?life\y'
     or t ~ '\ysuicid'
     or t ~ '\y(want|wanna|wish)\w*\s+to\s+die\y'
     or t ~ '\y(don.?t|do not|never)\s+want\s+to\s+(live|be alive)\y'
     or t ~ '\yjump(ing)?\s+(off|from)\y'
     or t ~ '\yoverdos'
     or t ~ '\ycut(ting)?\s+myself\y'
     or t ~ '\yself[\s-]?harm'
     or t ~ '\ykms\y'
     or t ~ 'mar+i?\s*poth?a'            -- te: "maripothaa/maripotha" (will die)
     or t ~ 'bach\s*nahi\s*sak'          -- hi: "bach nahi sakta" (can't survive)
     or t ~ 'mar\s*jau?ng'               -- hi: "mar jaunga/jaungi" (will die)
     or t ~ 'jeena\s*nahi'               -- hi: "jeena nahi (chahta)" (don't want to live)
  then
    return 'critical';
  end if;

  if t ~ '\yhopeless'
     or t ~ '\ycan.?t\s+go\s+on\y'
     or t ~ '\ygive\s+up\s+on\s+everything\y'
     or t ~ '\ynobody\s+(cares|loves|would\s+miss)\y'
     or t ~ '\yalone\s+forever\y'
     or t ~ '\yworthless\y'
     or t ~ '\ybreaking\s+down\y'
     or t ~ '\ypanic\s+attack\y'
     or t ~ '\yno\s+reason\s+to\s+(live|go\s+on)\y'
  then
    return 'elevated';
  end if;

  return 'normal';
end;
$$;

-- ── Crisis events: the author-facing response queue (#5) ────────────────────
create table if not exists public.nexus_crisis_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  post_id         uuid references public.nexus_posts(id) on delete cascade,
  comment_id      uuid references public.nexus_comments(id) on delete cascade,
  risk_level      text not null default 'critical',
  source          text not null default 'lexical',
  reasons         text,
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_nexus_crisis_user_open
  on public.nexus_crisis_events (user_id, created_at desc) where acknowledged_at is null;
alter table public.nexus_crisis_events enable row level security;
-- Owner-only: the author reads + acknowledges their own support prompts.
drop policy if exists nexus_crisis_owner_read on public.nexus_crisis_events;
create policy nexus_crisis_owner_read on public.nexus_crisis_events
  for select using (auth.uid() = user_id);
drop policy if exists nexus_crisis_owner_ack on public.nexus_crisis_events;
create policy nexus_crisis_owner_ack on public.nexus_crisis_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, update on public.nexus_crisis_events to authenticated;

-- ── Triggers: classify on the way in, soft-hide criticals, enqueue response ─
create or replace function public._nexus_post_crisis() returns trigger
language plpgsql security definer set search_path = public as $$
declare lvl text;
begin
  if new.is_ai_author is true then return new; end if;
  lvl := public.nexus_crisis_lexical(coalesce(new.title, '') || ' ' || coalesce(new.body, ''));
  new.risk_level := lvl;
  if lvl = 'critical' then new.is_soft_hidden := true; end if;
  return new;
exception when others then
  return new;
end;
$$;
drop trigger if exists trg_nexus_post_crisis on public.nexus_posts;
create trigger trg_nexus_post_crisis before insert on public.nexus_posts
  for each row execute function public._nexus_post_crisis();

create or replace function public._nexus_post_crisis_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.risk_level = 'critical' and new.is_ai_author is not true then
    insert into public.nexus_crisis_events (user_id, post_id, risk_level, source, reasons)
    values (new.author_user_id, new.id, 'critical', 'lexical', 'lexical-pattern');
  end if;
  return null;
exception when others then
  return null;
end;
$$;
drop trigger if exists trg_nexus_post_crisis_event on public.nexus_posts;
create trigger trg_nexus_post_crisis_event after insert on public.nexus_posts
  for each row execute function public._nexus_post_crisis_event();

create or replace function public._nexus_comment_crisis() returns trigger
language plpgsql security definer set search_path = public as $$
declare lvl text;
begin
  if new.is_ai_author is true then return new; end if;
  lvl := public.nexus_crisis_lexical(coalesce(new.body, ''));
  new.risk_level := lvl;
  if lvl = 'critical' then new.is_soft_hidden := true; end if;
  return new;
exception when others then
  return new;
end;
$$;
drop trigger if exists trg_nexus_comment_crisis on public.nexus_comments;
create trigger trg_nexus_comment_crisis before insert on public.nexus_comments
  for each row execute function public._nexus_comment_crisis();

create or replace function public._nexus_comment_crisis_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.risk_level = 'critical' and new.is_ai_author is not true then
    insert into public.nexus_crisis_events (user_id, comment_id, risk_level, source, reasons)
    values (new.author_user_id, new.id, 'critical', 'lexical', 'lexical-pattern');
  end if;
  return null;
exception when others then
  return null;
end;
$$;
drop trigger if exists trg_nexus_comment_crisis_event on public.nexus_comments;
create trigger trg_nexus_comment_crisis_event after insert on public.nexus_comments
  for each row execute function public._nexus_comment_crisis_event();

commit;
