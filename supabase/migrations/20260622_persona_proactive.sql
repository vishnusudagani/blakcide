-- Opt-in proactive check-ins for fantasy personas.
-- `proactive` (owner opt-in, default off): when on, the persona reaches out first
-- when the user reopens a thread that's gone quiet. `proactive_last_at` gates this
-- to ≤1 per ~18h. Delivery is lazy (on open) — true away-from-app push needs the
-- push/cron foundation, which is tracked separately.
alter table public.fantasy_personas
  add column if not exists proactive boolean default false,
  add column if not exists proactive_last_at timestamptz;
