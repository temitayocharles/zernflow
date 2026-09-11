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
Files: `.forgejo/workflows/ci.yml`, `scripts/smoke-test.mjs`, `scripts/smoke-config.mjs`, `docs/LOCAL_VALIDATION.md`, `supabase/migrations/`
Tests: local Vitest suite available; live smoke not executed.
### External system
Supabase / Northflank / Agent Social Gateway
### Exact action required
Provision disposable tenant-scoped runtime with migrations 00001–00020; use Node 24/npm 11. The smoke script now requires explicit disposable targets and write acknowledgement; configure them per `docs/LOCAL_VALIDATION.md`. It certifies only the legacy webhook path, not Gateway delivery. Production certification requires live provider acceptance, not only mocked tests.
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


## ITEM: Inbox browser and pagination acceptance
### Code status
COMPLETE
### Repository evidence
Commit: `8bad5ba` and subsequent hardening checkpoint on the active branch.
Files: `app/(dashboard)/dashboard/inbox/inbox-view.tsx`, `components/inbox/message-thread.tsx`, `lib/inbox/`, `app/api/v1/messages/route.ts`
Tests: message query, page merge, API route tests; full suite 165 passing tests.
### External system
Supabase / Agent Social Gateway / browser
### Exact action required
With an isolated authenticated tenant, populate a Gateway conversation with more than 50 messages, then test page loading, realtime arrivals and optimistic sends while switching conversations rapidly. Confirm page cursors from the real Gateway contract advance as expected.
### Environment variables / secret names
Existing Supabase and SOCIAL_GATEWAY_* configuration; no new provider secrets.
### Endpoint or callback expected
`GET /api/v1/messages?conversationId=<local-id>&paginated=true&limit=50&cursor=<opaque>`
### Verification procedure
Confirm older pages appear chronologically without duplicates or scroll jumps. Verify interrupted reads never show one conversation's messages in another. Disconnect Gateway and confirm retry UI, unchanged unread state on failed reads, and no false delivery success.
### Expected success result
History, pending sends and workspace boundaries remain intact under paging and realtime updates.
### Failure symptoms
Repeated cursors, missing history, cross-conversation messages, lost pending sends, or unread state cleared after failed reads.
### Rollback consideration
Revert UI paging independently. Default API callers still receive the legacy array response; no database migration is involved.

## ITEM: CRM migration and acceptance
### Code status
COMPLETE
### Repository evidence
Commit: CRM continuation slice on PR #11 (see git history).
Files: `supabase/migrations/00021_crm_foundations.sql`, `lib/crm/`, `lib/product/`, `app/api/v1/crm/`, `app/(dashboard)/dashboard/crm/`
Tests: `lib/product/database.test.ts`, `lib/crm/contracts.test.ts`.
### External system
Supabase / Northflank
### Exact action required
Apply forward migration 00021 after 00001–00020 on a disposable project, then promote after acceptance. Verify the API and CRM screens under two separate workspace accounts.
### Environment variables / secret names
Existing Supabase variables; no new secrets.
### Endpoint or callback expected
`/dashboard/crm/companies`, `/dashboard/crm/deals`, `/dashboard/crm/customer_profiles`, `/api/v1/crm/*`
### Verification procedure
Create company/profile/deal, link contact, add note, update deal to won and reopen. Confirm cross-workspace foreign keys fail, nonmembers cannot read, concurrent stale versions return conflict, and audit actor cannot be supplied by the browser.
### Expected success result
Durable customer entities, immutable notes/audit attribution, safe relationships, and visible error states.
### Failure symptoms
Missing tables (migration not applied), foreign records visible, silent conflicts, or forged audit attribution.
### Rollback consideration
Roll back application independently and retain customer data. Do not drop new tables in production as an automatic rollback.
