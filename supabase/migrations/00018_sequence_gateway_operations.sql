-- Sequence message delivery is durable in Agent Social Gateway. Persist the
-- remote operation identity on the enrollment so cron retries poll or retry the
-- same operation instead of creating a second send.

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS current_operation_id TEXT,
  ADD COLUMN IF NOT EXISTS operation_checks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS sequence_enrollments_gateway_operation_idx
  ON sequence_enrollments (current_operation_id)
  WHERE current_operation_id IS NOT NULL;

COMMENT ON COLUMN sequence_enrollments.current_operation_id IS
  'Agent Social Gateway durable operation for the current sequence step.';
COMMENT ON COLUMN sequence_enrollments.operation_checks IS
  'Number of bounded status checks for the current gateway operation.';
