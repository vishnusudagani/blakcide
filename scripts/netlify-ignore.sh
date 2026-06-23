#!/usr/bin/env bash
# Netlify build "ignore" command — decide whether to SKIP this build.
#   exit 0  = SKIP the build (no deploy, no build minutes spent)
#   exit !0 = BUILD as normal
#
# We SKIP only when a commit's changes are confined to paths that cannot affect
# the published Astro site or its Netlify functions:
#   - supabase/**      DB migrations + edge functions deploy via Supabase, not Netlify
#   - root-level *.md  top-level docs/roadmaps (README, *-ROADMAP.md, etc.)
# IMPORTANT: src/content/blog/*.md IS site content (Astro renders it), so nested
# markdown is treated as site-affecting and DOES build. Anything under src/,
# public/, netlify/functions/, symp-core/, scripts/, or any config → build.
#
# Errs toward building: missing refs or a failed diff → build.
set -u
base="${CACHED_COMMIT_REF:-}"
head="${COMMIT_REF:-}"
if [ -z "$base" ] || [ -z "$head" ]; then echo "no diff base → build"; exit 1; fi
changed="$(git diff --name-only "$base" "$head" 2>/dev/null)" || { echo "git diff failed → build"; exit 1; }
if [ -z "$changed" ]; then echo "no file changes → skip"; exit 0; fi
# Any changed file that is NOT (under supabase/ or a root-level .md) → must build.
if printf '%s\n' "$changed" | grep -qvE '^(supabase/|[^/]+\.md$)'; then
  echo "site-affecting changes → build"; exit 1
fi
echo "only supabase/** + root docs changed → skip build"; exit 0
