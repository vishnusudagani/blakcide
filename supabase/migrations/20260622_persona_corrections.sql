-- In-chat tuning: a running list of adjustments the owner asks of THIS persona
-- ("shorter replies", "more sarcastic", "use more Telugu"). Injected into
-- buildFantasyPersonaCard so the character always honors them.
alter table public.fantasy_personas add column if not exists corrections text;
