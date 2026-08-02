-- Agent Social Gateway is authoritative for conversation identity and messages.
-- ZernFlow retains late_conversation_id temporarily as the remote gateway
-- conversation identifier while the schema is renamed in a later migration.
-- The partial workspace-scoped unique index makes repeated syncs and concurrent
-- projection requests idempotent without constraining legacy NULL rows.

CREATE UNIQUE INDEX IF NOT EXISTS conversations_workspace_gateway_id_uidx
  ON conversations (workspace_id, late_conversation_id)
  WHERE late_conversation_id IS NOT NULL;

COMMENT ON COLUMN conversations.late_conversation_id IS
  'Temporary migration alias for the Agent Social Gateway conversation ID.';

COMMENT ON COLUMN channels.late_account_id IS
  'Temporary migration alias for the Agent Social Gateway provider account ID.';
