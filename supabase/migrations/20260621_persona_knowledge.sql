-- Cluster 1: give a fantasy persona lore + a voice it nails.
--   knowledge_note     — things it should ALWAYS know (world/lore/facts/rules).
--   example_dialogues  — a few sample lines in its voice to lock the style.
-- Both injected into buildFantasyPersonaCard (chat + call).

alter table public.fantasy_personas add column if not exists knowledge_note    text;
alter table public.fantasy_personas add column if not exists example_dialogues text;
