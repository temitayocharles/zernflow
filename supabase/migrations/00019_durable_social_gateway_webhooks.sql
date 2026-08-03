-- Upgrade the existing webhook idempotency ledger into a durable processing
-- ledger. Existing Zernio inserts remain compatible because defaults preserve
-- the previous completed-on-insert behavior.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'zernio',
  ADD COLUMN IF NOT EXISTS delivery_id TEXT,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

UPDATE webhook_events
SET completed_at = COALESCE(completed_at, received_at)
WHERE status = 'completed';

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_source_check,
  ADD CONSTRAINT webhook_events_source_check
    CHECK (source IN ('zernio', 'social_gateway')),
  DROP CONSTRAINT IF EXISTS webhook_events_status_check,
  ADD CONSTRAINT webhook_events_status_check
    CHECK (status IN ('processing', 'completed', 'failed')),
  DROP CONSTRAINT IF EXISTS webhook_events_attempt_count_check,
  ADD CONSTRAINT webhook_events_attempt_count_check
    CHECK (attempt_count >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_delivery_id_idx
  ON webhook_events (delivery_id)
  WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_events_processing_idx
  ON webhook_events (status, claimed_at)
  WHERE status IN ('processing', 'failed');

COMMENT ON TABLE webhook_events IS
  'Idempotency and processing ledger for signed gateway and legacy webhook deliveries.';
COMMENT ON COLUMN webhook_events.event_id IS
  'Stable upstream event identifier. Social Gateway retries retain this value.';
COMMENT ON COLUMN webhook_events.delivery_id IS
  'Unique delivery attempt identity used for observability, not event deduplication.';
