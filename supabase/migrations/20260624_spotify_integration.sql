-- Music integration (Spotify) — reuses the existing app-integration plumbing
-- (symp_integrations state + symp_oauth_tokens server-only vault, both from the
-- Gmail OAuth backend). The only schema change needed is allowing a 'music'
-- category so Spotify shows as its own thing in the "Your apps" grid.

alter table public.symp_integrations
  drop constraint if exists symp_integrations_category_check;
alter table public.symp_integrations
  add constraint symp_integrations_category_check
  check (category in ('account','food','quick_commerce','cabs','music','other'));
