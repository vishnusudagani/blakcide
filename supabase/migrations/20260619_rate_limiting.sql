-- Per-user rate limiting for AI endpoints — a cost-DoS backstop. The symp proxy
-- calls check_rate_limit() with the caller's JWT before forwarding to any billed
-- LLM endpoint (chat/vision/transcribe/voice/tts/title). Enforces a per-minute
-- burst cap and a per-hour sustained cap. Definer fn keyed on auth.uid().
create table if not exists public.rate_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_lookup on public.rate_events (user_id, bucket, created_at desc);
alter table public.rate_events enable row level security;  -- definer-only; no policies → no direct client access

create or replace function public.check_rate_limit(p_bucket text, p_per_min int, p_per_hour int)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n_min int; n_hour int;
begin
  if uid is null then return false; end if;                 -- unauthenticated → denied
  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*)
    into n_min, n_hour
    from public.rate_events
    where user_id = uid and bucket = p_bucket and created_at > now() - interval '1 hour';
  if n_min >= p_per_min or n_hour >= p_per_hour then return false; end if;
  insert into public.rate_events(user_id, bucket) values (uid, p_bucket);
  delete from public.rate_events where user_id = uid and bucket = p_bucket and created_at < now() - interval '1 hour';
  return true;
end; $$;
revoke execute on function public.check_rate_limit(text,int,int) from public, anon;
grant  execute on function public.check_rate_limit(text,int,int) to authenticated;
