begin;
-- Supabase may explicitly grant anon/authenticated EXECUTE via default privileges.
-- Revoking PUBLIC alone does not remove those grants. These RPCs are used only
-- by signed webhook receivers, authenticated cron workers and service-role code.
revoke all on function increment_unread(uuid,text) from public,anon,authenticated;
revoke all on function increment_broadcast_sent(uuid) from public,anon,authenticated;
revoke all on function increment_broadcast_failed(uuid) from public,anon,authenticated;
revoke all on function claim_social_gateway_webhook(text,text,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function apply_social_gateway_inbound_conversation(uuid,timestamptz,text,text) from public,anon,authenticated;
revoke all on function refresh_sla_notifications(timestamptz) from public,anon,authenticated;
grant execute on function increment_unread(uuid,text),increment_broadcast_sent(uuid),increment_broadcast_failed(uuid),claim_social_gateway_webhook(text,text,text,uuid,jsonb),apply_social_gateway_inbound_conversation(uuid,timestamptz,text,text),refresh_sla_notifications(timestamptz) to service_role;
alter function increment_unread(uuid,text) set search_path=public;
alter function increment_broadcast_sent(uuid) set search_path=public;
alter function increment_broadcast_failed(uuid) set search_path=public;
alter function is_workspace_member(uuid) set search_path=public;
commit;
