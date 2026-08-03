-- Apply an inbound gateway event to an existing projected conversation without
-- regressing its visible ordering when delayed or out-of-order webhooks arrive.

CREATE OR REPLACE FUNCTION apply_social_gateway_inbound_conversation(
  p_conversation_id UUID,
  p_occurred_at TIMESTAMPTZ,
  p_preview TEXT,
  p_gateway_conversation_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations
  SET unread_count = unread_count + 1,
      status = 'open',
      late_conversation_id = COALESCE(
        p_gateway_conversation_id,
        late_conversation_id
      ),
      last_message_preview = CASE
        WHEN last_message_at IS NULL OR p_occurred_at >= last_message_at
          THEN p_preview
        ELSE last_message_preview
      END,
      last_message_at = CASE
        WHEN last_message_at IS NULL OR p_occurred_at >= last_message_at
          THEN p_occurred_at
        ELSE last_message_at
      END
  WHERE id = p_conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION apply_social_gateway_inbound_conversation(UUID, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_social_gateway_inbound_conversation(UUID, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;
