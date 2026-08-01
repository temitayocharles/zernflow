# Controlled Fork Baseline Audit — 2026-08-01

Snapshot: `e8a0a16f2de46b86e506edbfe06c192f3cb1390a`

## Validation

- `npm ci`: passed.
- `npm test`: 39/39 tests passed.
- `npm run lint`: no errors; 45 warnings.
- Production build: passed with placeholder Supabase build-time values and a 2 GB Node heap.
- Initial audit: 11 findings — 1 low, 1 moderate and 9 high.
- A local trial upgraded Next.js from `16.1.6` to `16.2.12`, PostCSS from `8.5.6` to `8.5.25`, and refreshed transitive packages.
- The local trial reduced findings but Next.js still bundles PostCSS `8.4.31`; npm continues to report findings through that nested dependency. An invalid override and npm's suggested forced downgrade to Next.js 9 are rejected. No dependency edit is accepted until the lockfile and full gate pass together.

## Hosted dependency map

Direct SDK dependency: `@zernio/node`.

Primary seams:

- `lib/zernio-client.ts` — SDK construction.
- `lib/zernio-webhook.ts` — hosted webhook settings.
- `app/api/v1/channels/connect` — hosted connect URL and profiles.
- `app/api/v1/channels/sync` — account discovery and webhook registration.
- `app/api/v1/messages` — conversation reads and sends.
- `app/api/webhooks/late` — hosted payload shape and identifiers.
- `lib/inbox-sync.ts` — hosted inbox listing.
- `lib/comment-processor.ts` — public comment reply.
- `lib/flow-engine/engine.ts` — inbox sends, public replies and comment-to-DM.
- `lib/flow-engine/nodes/ai-response.ts` — AI response dispatch.
- `lib/sequence-processor.ts` and `app/api/cron/jobs` — scheduled sends.

## Schema coupling

- `workspaces.late_api_key_encrypted` is plain text despite its name.
- `workspaces.ai_api_key` and `workspaces.webhook_secret` are stored in workspace rows.
- `channels.late_account_id` and `conversations.late_conversation_id` couple operator records to hosted identifiers.
- Several RLS policies authorize by membership or authentication rather than administrative role.

## Decision

Introduce a provider-neutral interface first, then replace the hosted implementation with Agent Social Gateway. Secrets move to Vault before any production provider account is connected.
