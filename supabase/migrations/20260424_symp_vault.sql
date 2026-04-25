-- Symp.ai Vault — hidden backend profile store
-- Decoupled from Blaksyd's user-facing tables (profiles, journals, chats, connect_sessions).
-- Access pattern: service-role only. Blaksyd's anon/authenticated JWTs must NOT reach these.
-- Run in Supabase SQL editor or via supabase db push.

-- ── 1. Vault profile — master row per user ─────────────────────────────
-- Denormalised "current state" mirror. Heavy reads (chat context assembly, whisperer)
-- hit this single row instead of re-aggregating summaries + analyses per request.
CREATE TABLE IF NOT EXISTS symp_vault_profiles (
    user_id          UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    latest_snapshot  JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- most-recent daily analysis
    running_themes   JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- rolling array of themes
    risk_flags       JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {self_harm:bool, crisis:bool, ...}
    last_analysed_on DATE,                                        -- for "analysed yesterday yet?" check
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Daily session summaries ─────────────────────────────────────────
-- Enforces Module 3's "ONE AI Journal + ONE Human Connect Journal per day per user"
-- at the DB level via the UNIQUE constraint. Post-session ingest either INSERTs or
-- UPDATEs (appends to content + session_refs) based on this key.
CREATE TABLE IF NOT EXISTS symp_session_summaries (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    summary_date  DATE        NOT NULL,
    source        TEXT        NOT NULL CHECK (source IN ('ai','human')),
    content       TEXT        NOT NULL DEFAULT '',
    session_refs  JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{session_id, session_type, started_at, ended_at}]
    extracted     JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {names:[], emotions:[], times:[], specifics:[]}
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, summary_date, source)
);

CREATE INDEX IF NOT EXISTS idx_symp_session_summaries_user_date
    ON symp_session_summaries (user_id, summary_date DESC);

-- ── 3. Daily psych analyses — Module 4 structured output ──────────────
-- One strict-JSON row per (user, day). Module 4 writes this; the Vault profile
-- mirrors the latest into latest_snapshot.
CREATE TABLE IF NOT EXISTS symp_daily_analyses (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    analysis_date  DATE        NOT NULL,
    psychology     JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {mood_shifts, stress_signals, ...}
    key_themes     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    metrics        JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {platform_time_mins, ...}
    integrations   JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {spotify_influence, ...}
    raw_inputs     JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- audit: source summary IDs + hashes
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, analysis_date)
);

CREATE INDEX IF NOT EXISTS idx_symp_daily_analyses_user_date
    ON symp_daily_analyses (user_id, analysis_date DESC);

-- ── 4. Live whisperer sessions — Module 2 state ───────────────────────
-- Tracks an in-progress human-listener call being observed by the Whisperer.
-- Created when the listener upgrades a connect_session to a live-copilot session.
CREATE TABLE IF NOT EXISTS symp_live_sessions (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    connect_session_id UUID        REFERENCES connect_sessions(id) ON DELETE CASCADE,
    user_id            UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    listener_id        UUID        REFERENCES listeners(id) ON DELETE SET NULL,
    status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    transcript_buffer  TEXT        NOT NULL DEFAULT '',
    last_hint_at       TIMESTAMPTZ,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_symp_live_sessions_status
    ON symp_live_sessions (status, started_at DESC);

-- ── 5. API access log — audit + observability ─────────────────────────
-- Every Symp.ai endpoint writes one row. Admin dashboard reads from here
-- for latency, error rate, per-user usage.
CREATE TABLE IF NOT EXISTS symp_api_access_log (
    id           BIGSERIAL   PRIMARY KEY,
    request_id   UUID        NOT NULL,
    endpoint     TEXT        NOT NULL,                -- e.g. '/api/symp/v1/chat'
    user_id      UUID,                                 -- nullable: some endpoints don't carry user_id
    status_code  INTEGER     NOT NULL,
    latency_ms   INTEGER,
    error_code   TEXT,                                 -- populated when status >= 400
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symp_api_access_log_created
    ON symp_api_access_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_symp_api_access_log_user
    ON symp_api_access_log (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ── 6. updated_at touch trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION symp_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_symp_vault_profiles_touch    ON symp_vault_profiles;
DROP TRIGGER IF EXISTS trg_symp_session_summaries_touch ON symp_session_summaries;

CREATE TRIGGER trg_symp_vault_profiles_touch
    BEFORE UPDATE ON symp_vault_profiles
    FOR EACH ROW EXECUTE FUNCTION symp_touch_updated_at();

CREATE TRIGGER trg_symp_session_summaries_touch
    BEFORE UPDATE ON symp_session_summaries
    FOR EACH ROW EXECUTE FUNCTION symp_touch_updated_at();

-- ── 7. RLS — deny-all for anon/authenticated; service-role bypasses ──
-- Enabling RLS with NO policies means every non-service-role request is denied.
-- Symp.ai handlers must instantiate Supabase with SUPABASE_SERVICE_ROLE_KEY.
ALTER TABLE symp_vault_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE symp_session_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE symp_daily_analyses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE symp_live_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE symp_api_access_log    ENABLE ROW LEVEL SECURITY;
