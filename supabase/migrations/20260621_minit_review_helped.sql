-- Phase 4b (#34): richer post-session feedback — "what helped" tags on the review.
-- (Applied to prod via MCP apply_migration; this file is the repo record.)
alter table public.listener_reviews add column if not exists helped text[];
