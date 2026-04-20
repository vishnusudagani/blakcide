-- Human Connect improvements: listener minutes tracking + listener reviews
-- Run in Supabase SQL editor or via supabase db push

-- ── Feature 5: Minutes tracking ──────────────────────────────────────────────
ALTER TABLE listeners
    ADD COLUMN IF NOT EXISTS total_minutes_spoken NUMERIC(10,2) NOT NULL DEFAULT 0;

-- ── Feature 6: Listener reviews ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listener_reviews (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL REFERENCES connect_sessions(id) ON DELETE CASCADE,
    listener_id   UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
    rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_text   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id) -- one review per session
);

-- Index for fetching all reviews of a listener
CREATE INDEX IF NOT EXISTS idx_listener_reviews_listener ON listener_reviews (listener_id, created_at DESC);

-- Denormalised average rating on listeners row (updated by trigger)
ALTER TABLE listeners
    ADD COLUMN IF NOT EXISTS rating        NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS review_count  INTEGER NOT NULL DEFAULT 0;

-- Trigger: keep listeners.rating + review_count in sync
CREATE OR REPLACE FUNCTION update_listener_rating()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE listeners
    SET
        rating       = (SELECT ROUND(AVG(rating)::NUMERIC, 2) FROM listener_reviews WHERE listener_id = COALESCE(NEW.listener_id, OLD.listener_id)),
        review_count = (SELECT COUNT(*)                        FROM listener_reviews WHERE listener_id = COALESCE(NEW.listener_id, OLD.listener_id))
    WHERE id = COALESCE(NEW.listener_id, OLD.listener_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_listener_rating ON listener_reviews;
CREATE TRIGGER trg_update_listener_rating
    AFTER INSERT OR UPDATE OR DELETE ON listener_reviews
    FOR EACH ROW EXECUTE FUNCTION update_listener_rating();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE listener_reviews ENABLE ROW LEVEL SECURITY;

-- Users can read all reviews (shown on listener cards)
CREATE POLICY "reviews_read_all" ON listener_reviews FOR SELECT USING (true);

-- Only the session's user can insert their own review
CREATE POLICY "reviews_insert_own" ON listener_reviews FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update/delete only their own review
CREATE POLICY "reviews_update_own" ON listener_reviews FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "reviews_delete_own" ON listener_reviews FOR DELETE USING (auth.uid() = user_id);
