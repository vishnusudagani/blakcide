-- Human Connect (Minit) — listener_reviews (was missing on this DB).
-- The seeker's post-session review + feel-delta writes here; a trigger keeps
-- listeners.rating + listeners.reviews_count in sync (note: live column is
-- reviews_count, not review_count from the older repo migration).

create table if not exists public.listener_reviews (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.connect_sessions(id) on delete cascade,
  listener_id uuid references public.listeners(id) on delete cascade,
  user_id uuid not null,
  rating smallint not null check (rating between 1 and 5),
  review_text text,
  created_at timestamptz not null default now(),
  unique (session_id)
);
alter table public.listener_reviews enable row level security;
drop policy if exists "lr_read" on public.listener_reviews;
create policy "lr_read" on public.listener_reviews for select using (true);
drop policy if exists "lr_insert_own" on public.listener_reviews;
create policy "lr_insert_own" on public.listener_reviews for insert with check (user_id = auth.uid());

create or replace function public.update_listener_rating() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update public.listeners set
    rating = (select round(avg(rating)::numeric, 2) from public.listener_reviews where listener_id = coalesce(new.listener_id, old.listener_id)),
    reviews_count = (select count(*) from public.listener_reviews where listener_id = coalesce(new.listener_id, old.listener_id))
  where id = coalesce(new.listener_id, old.listener_id);
  return null;
end; $$;
drop trigger if exists trg_update_listener_rating on public.listener_reviews;
create trigger trg_update_listener_rating after insert or update or delete on public.listener_reviews for each row execute function public.update_listener_rating();
