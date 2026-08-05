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

ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_jobs_type_dedupe_key_idx
  ON scheduled_jobs (type, dedupe_key);

CREATE OR REPLACE FUNCTION claim_social_gateway_webhook(
  p_event_id TEXT,
  p_delivery_id TEXT,
  p_event_type TEXT,
  p_channel_id UUID,
  p_envelope JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_event_id TEXT;
  existing_status TEXT;
  conflicting_event_id TEXT;
BEGIN
  INSERT INTO webhook_events (
    event_id,
    source,
    delivery_id,
    event_type,
    status,
    attempt_count,
    claimed_at,
    completed_at,
    last_error
  ) VALUES (
    p_event_id,
    'social_gateway',
    p_delivery_id,
    p_event_type,
    'processing',
    1,
    now(),
    NULL,
    NULL
  )
  ON CONFLICT DO NOTHING
  RETURNING event_id INTO inserted_event_id;

  IF inserted_event_id IS NULL THEN
    SELECT event_id
    INTO conflicting_event_id
    FROM webhook_events
    WHERE delivery_id = p_delivery_id;

    IF conflicting_event_id IS NOT NULL AND conflicting_event_id <> p_event_id THEN
      RAISE EXCEPTION 'delivery id is already assigned to a different event';
    END IF;

    SELECT status
    INTO existing_status
    FROM webhook_events
    WHERE event_id = p_event_id
    FOR UPDATE;

    IF existing_status IS NULL THEN
      RAISE EXCEPTION 'event claim conflict could not be resolved';
    END IF;

    IF existing_status = 'completed' THEN
      RETURN 'completed';
    END IF;

    IF existing_status = 'processing' THEN
      RETURN 'already_queued';
    END IF;

    UPDATE webhook_events
    SET source = 'social_gateway',
        delivery_id = p_delivery_id,
        event_type = p_event_type,
        status = 'processing',
        attempt_count = attempt_count + 1,
        claimed_at = now(),
        completed_at = NULL,
        last_error = NULL
    WHERE event_id = p_event_id;
  END IF;

  INSERT INTO scheduled_jobs (
    type,
    payload,
    run_at,
    status,
    attempts,
    last_error,
    claimed_at,
    dedupe_key
  ) VALUES (
    'process_social_gateway_event',
    jsonb_build_object(
      'eventId', p_event_id,
      'channelId', p_channel_id,
      'envelope', p_envelope
    ),
    now(),
    'pending',
    0,
    NULL,
    NULL,
    p_event_id
  )
  ON CONFLICT (type, dedupe_key) DO UPDATE
  SET payload = EXCLUDED.payload,
      run_at = now(),
      status = 'pending',
      attempts = 0,
      last_error = NULL,
      claimed_at = NULL;

  RETURN CASE
    WHEN inserted_event_id IS NULL THEN 'requeued'
    ELSE 'queued'
  END;
END;
$$;

REVOKE ALL ON FUNCTION claim_social_gateway_webhook(TEXT, TEXT, TEXT, UUID, JSONB)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_social_gateway_webhook(TEXT, TEXT, TEXT, UUID, JSONB)
  TO service_role;

COMMENT ON TABLE webhook_events IS
  'Idempotency and processing ledger for signed gateway and legacy webhook deliveries.';
COMMENT ON COLUMN webhook_events.event_id IS
  'Stable upstream event identifier. Social Gateway retries retain this value.';
COMMENT ON COLUMN webhook_events.delivery_id IS
  'Unique delivery attempt identity used for observability, not event deduplication.';
COMMENT ON COLUMN scheduled_jobs.dedupe_key IS
  'Optional durable idempotency key for one logical job across retries and requeues.';
