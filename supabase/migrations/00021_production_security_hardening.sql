-- Production hardening: lock down SECURITY DEFINER routines while preserving RLS helpers.

ALTER FUNCTION omni_channel.update_updated_at() SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.increment_unread(uuid, text) SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.increment_broadcast_sent(uuid) SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.increment_broadcast_failed(uuid) SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.is_workspace_member(uuid) SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.is_workspace_owner(uuid) SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.handle_new_user() SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.claim_social_gateway_webhook(text, text, text, uuid, jsonb) SET search_path = pg_catalog, omni_channel;
ALTER FUNCTION omni_channel.apply_social_gateway_inbound_conversation(uuid, timestamptz, text, text) SET search_path = pg_catalog, omni_channel;

REVOKE ALL ON FUNCTION omni_channel.update_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.increment_unread(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.increment_broadcast_sent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.increment_broadcast_failed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.claim_social_gateway_webhook(text, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.apply_social_gateway_inbound_conversation(uuid, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION omni_channel.is_workspace_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION omni_channel.is_workspace_owner(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION omni_channel.is_workspace_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION omni_channel.is_workspace_owner(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION omni_channel.update_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION omni_channel.increment_unread(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION omni_channel.increment_broadcast_sent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION omni_channel.increment_broadcast_failed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION omni_channel.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION omni_channel.claim_social_gateway_webhook(text, text, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION omni_channel.apply_social_gateway_inbound_conversation(uuid, timestamptz, text, text) TO service_role;
