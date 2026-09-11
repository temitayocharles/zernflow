# LM Arena External Integration Handoff
## ITEM: Gateway contract and live channel acceptance
### Code status
PARTIAL
### Repository evidence
Commit: baseline `88d647b`; subsequent checkpoints on `arena/01a091fb-zernflow`.
Files: `lib/social-gateway/types.ts`, `lib/social-gateway/client.ts`, `app/api/v1/channels/connect/route.ts`
Tests: existing Gateway client, reply, channel-sync and conversation-sync tests.
### External system
Agent Social Gateway / Vault / OAuth provider / Northflank
### Exact action required
Provide repository access to canonical Gateway docs and validate the existing Meta readiness/connection and Telegram account/reply contracts against the deployed backend. Perform owner-interactive Meta login and asset installation; configure Telegram credentials only in Gateway/Vault and import with Sync. Do not paste secrets into repository or chat.
### Environment variables / secret names
SOCIAL_GATEWAY_BASE_URL, SOCIAL_GATEWAY_API_KEY, SOCIAL_GATEWAY_ADMIN_API_KEY, SOCIAL_GATEWAY_AGENT_CREDENTIAL, SOCIAL_GATEWAY_WEBHOOK_SECRET, SOCIAL_GATEWAY_WORKSPACE_REF, NEXT_PUBLIC_APP_URL
### Endpoint or callback expected
`/dashboard/channels/callback`, `/api/webhooks/social-gateway`; Gateway routes as implemented in `lib/social-gateway/client.ts` (do not infer new routes).
### Verification procedure
On an isolated tenant, connect assets, synchronize channels, deliver signed inbound events, send a reply and confirm the actual durable operation succeeds. Confirm accounts cannot be imported/read by another tenant.
### Expected success result
Real incoming conversation and outbound delivery with correct workspace attribution; no credentials in browser payloads.
### Failure symptoms
Unavailable readiness, rejected OAuth, missing accounts, delivery failure or cross-tenant projection.
### Rollback consideration
Revert application changes if needed; retain existing Gateway credentials and durable operation/event state. No database changes in initial connector slice.

## ITEM: Full runtime validation
### Code status
BLOCKED
### Repository evidence
Commit: baseline `88d647b`
Files: `.forgejo/workflows/ci.yml` (inspect actual workflow filenames), `scripts/smoke-test.mjs`, `supabase/migrations/`
Tests: local Vitest suite available; live smoke not executed.
### External system
Supabase / Northflank / Agent Social Gateway
### Exact action required
Provision disposable tenant-scoped runtime with migrations 00001–00020; use Node 24/npm 11. Replace unsafe hardcoded smoke target inputs before running the legacy smoke script. Production certification requires live provider acceptance, not only mocked tests.
### Environment variables / secret names
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
### Endpoint or callback expected
Isolated application URL and protected cron/webhook endpoints.
### Verification procedure
Run lint, typecheck, tests, production build and tenant-isolated flow/inbox/provider smoke. Verify migration objects using the migration runbook.
### Expected success result
Full local checks and live acceptance independently recorded with deployment revision.
### Failure symptoms
Missing migration objects, authentication failures, provider failures, or cross-tenant data.
### Rollback consideration
Do not reset any production database or delete durable Gateway state.
