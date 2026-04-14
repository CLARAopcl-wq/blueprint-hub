-- AI Rate Limits table
-- Tracks daily API call counts per user
-- Auto-cleans entries older than 7 days

CREATE TABLE IF NOT EXISTS ai_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_ai_rate_limits_updated ON ai_rate_limits(updated_at);

-- Auto-delete old entries (keeps table small)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM ai_rate_limits 
  WHERE updated_at < NOW() - INTERVAL '7 days';
$$;
