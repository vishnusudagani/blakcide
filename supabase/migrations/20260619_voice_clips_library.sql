-- Persona Voice — Multi-clip Library (additive, non-breaking)
--
-- Phase 0 of the Persona voice redesign: move from ONE reference clip per
-- (user, language) to a GROWING LIBRARY of clips, so the more the user speaks
-- the better the reference we can pick — and so we have a corpus to fine-tune on
-- later (Phase 2). This migration is ADDITIVE and changes nothing existing:
--   - public.symp_voice_clones (one active clip/lang) is left UNTOUCHED; the live
--     function keeps working and is used as a fallback during the transition.
--   - a new public.symp_voice_clips table holds the library. enroll appends here;
--     getRef/speak select the best clip from here.
--
-- Forward-looking columns are baked in now so Phase 2 (passive capture from Blak
-- calls + voice notes; per-user fine-tuning) needs NO further migration:
--   - source        : where the clip came from (enroll | blak_call | voice_note)
--   - emotion (+conf): emotion-matched reference selection (auto-tagged by SER)
--   - duration_ms    : pick the longest/most-content reference
--   - quality_snr_db : pick the cleanest reference (enrollment-gate telemetry)
--
-- Privacy: clips reuse the SAME private 'voice-refs' bucket + per-user RLS as
-- symp_voice_clones (biometric-sensitive personal data, India DPDP). One-tap
-- delete soft-deletes every clip; a purge job clears the Storage objects.

-- ── 1. symp_voice_clips — the growing per-user library ─────────────────────────
create table if not exists public.symp_voice_clips (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references auth.users(id) on delete cascade,

    language            text not null
                        check (language in ('en','hi','te','ta','kn','ml','mr','bn','gu','pa','or','as')),

    clip_path           text not null,            -- object path in the private 'voice-refs' bucket
    transcript          text,                     -- whisper transcript (optional OmniVoice, required IndicF5)
    duration_ms         integer,                  -- helps pick the longest/most-content reference
    quality_snr_db      numeric,                  -- enrollment-gate telemetry; helps pick the cleanest clip

    emotion             text not null default 'neutral'
                        check (emotion in ('neutral','happy','excited','calm','serious','sad')),
    emotion_confidence  numeric,

    source              text not null default 'enroll'
                        check (source in ('enroll','blak_call','voice_note')),
    prompt_phrase       text,                     -- phrase read aloud (enroll); null for passive capture
    liveness_passed     boolean not null default false,
    consent_id          uuid,                     -- consent row this clip was captured under

    status              text not null default 'ready'
                        check (status in ('pending','processing','ready','failed','deleted')),

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    deleted_at          timestamptz
);

-- Selection: best ready clip for a (user, language), optionally emotion-matched.
create index if not exists symp_voice_clips_user_lang_idx
    on public.symp_voice_clips (user_id, language)
    where deleted_at is null and status = 'ready';

create index if not exists symp_voice_clips_user_lang_emotion_idx
    on public.symp_voice_clips (user_id, language, emotion)
    where deleted_at is null and status = 'ready';

create index if not exists symp_voice_clips_user_idx
    on public.symp_voice_clips (user_id)
    where deleted_at is null;

-- updated_at trigger (per-table, matching the voice_clones migration convention)
create or replace function public.touch_symp_voice_clips_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_symp_voice_clips_touch on public.symp_voice_clips;
create trigger trg_symp_voice_clips_touch
    before update on public.symp_voice_clips
    for each row execute function public.touch_symp_voice_clips_updated_at();

-- ── 2. RLS — owner-only (service role bypasses); mirrors symp_voice_clones ─────
alter table public.symp_voice_clips enable row level security;

drop policy if exists symp_voice_clips_select_own on public.symp_voice_clips;
create policy symp_voice_clips_select_own on public.symp_voice_clips
    for select using (auth.uid() = user_id);

drop policy if exists symp_voice_clips_insert_own on public.symp_voice_clips;
create policy symp_voice_clips_insert_own on public.symp_voice_clips
    for insert with check (auth.uid() = user_id);

drop policy if exists symp_voice_clips_update_own on public.symp_voice_clips;
create policy symp_voice_clips_update_own on public.symp_voice_clips
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists symp_voice_clips_delete_own on public.symp_voice_clips;
create policy symp_voice_clips_delete_own on public.symp_voice_clips
    for delete using (auth.uid() = user_id);

-- ── 3. Backfill — seed the library from existing single clones ────────────────
-- Existing users immediately have a (1-clip) library. Idempotent: skips clones
-- whose clip_path is already represented in the library.
insert into public.symp_voice_clips
    (user_id, language, clip_path, transcript, emotion, source, liveness_passed, consent_id, status, created_at)
select
    c.user_id, c.language, c.ref_clip_path, c.ref_transcript, 'neutral', 'enroll', true, c.consent_id, 'ready', c.created_at
from public.symp_voice_clones c
where c.status = 'ready' and c.deleted_at is null
  and not exists (
      select 1 from public.symp_voice_clips k
      where k.user_id = c.user_id and k.clip_path = c.ref_clip_path
  );

-- ── 4. Verification ───────────────────────────────────────────────────────────
do $$
begin
    if to_regclass('public.symp_voice_clips') is null then
        raise exception 'symp_voice_clips table missing after migration';
    end if;
    raise notice 'Voice clips library migration OK.';
end $$;
