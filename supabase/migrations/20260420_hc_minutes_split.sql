-- Human Connect: split listener minutes into chat vs call buckets.
-- Keeps legacy total_minutes_spoken in sync for any code still reading it.

ALTER TABLE listeners
    ADD COLUMN IF NOT EXISTS total_call_minutes NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_chat_minutes NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Back-fill: previously total_minutes_spoken only ever received call minutes.
UPDATE listeners
SET total_call_minutes = total_minutes_spoken
WHERE total_minutes_spoken > 0 AND total_call_minutes = 0;
