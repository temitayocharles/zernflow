# ZernFlow

ZernFlow is the operator and workflow layer for the self-hosted Omnichannel Agent Operations Platform. It provides the visual flow builder, unified inbox, contact workspace, broadcasts, sequences, human takeover and approval-oriented operator experience.

ZernFlow does not own provider credentials or act as the authoritative social-message store. Those responsibilities belong to Agent Social Gateway.

## Architecture

```text
Operator and agent dashboard
            |
         ZernFlow
workflow builder, inbox projection, contacts, assignments,
human handoff, sequences and scheduled job execution
            |
  Agent Social Gateway
provider accounts, OAuth, Vault credentials, normalized events,
authoritative conversations/messages, durable operations, REST and MCP
            |
 Postiz and direct provider APIs
            |
Facebook, Instagram, WhatsApp, Telegram, LinkedIn,
TikTok and other supported channels
```

### Responsibility boundaries

ZernFlow owns:

- visual flows, triggers, conditions and operator-facing automation configuration;
- projected contacts and conversation metadata for the unified inbox;
- human takeover state, assignments, team access and flow execution;
- scheduled ZernFlow jobs for broadcasts, sequences and delayed flow resumes;
- the signed Agent Social Gateway webhook receiver and its local processing ledger.

Agent Social Gateway owns:

- provider accounts, OAuth state, token refresh and provider capability discovery;
- provider credentials and webhook signing secrets stored through Vault references;
- normalized inbound events and authoritative messages and conversations;
- durable outbound operations, retries, reconciliation and dead letters;
- provider policy, approvals, agent identities, REST and MCP execution contracts;
- Postiz integration for publishing and scheduling where Postiz is the best downstream engine.

Zernio is an optional compatibility provider only. Legacy `@zernio/node` access is disabled unless the server-only environment value `ENABLE_LEGACY_ZERNIO=true` is set exactly. New work must use Agent Social Gateway.

## Current product surface

- visual flow builder with trigger, message, condition, delay, AI, HTTP, sequence, subscription, human takeover and routing nodes;
- unified inbox backed by gateway conversation reads and local contact/conversation projection;
- signed, replay-bounded gateway event delivery with durable local processing jobs;
- contacts, tags, custom fields and segments;
- broadcasts and drip sequences routed through durable gateway operations;
- gateway-first public comment replies with stable idempotency keys;
- channel/account synchronization from the gateway control plane;
- human takeover, conversation assignment, escalation and approval controls;
- analytics events and operator-visible processing state;
- bounded legacy Zernio fallback for migration-only paths.

Provider availability remains capability-driven. An action is exposed only when the official provider API, Postiz or an explicitly configured compatibility provider supports it.

## Prerequisites

- Node.js 24.x and npm 11 or newer;
- a Supabase project for PostgreSQL, Auth and Realtime;
- a deployed Agent Social Gateway API and worker using the same gateway database;
- server-side operator and admin credentials issued for Agent Social Gateway;
- a strong shared HMAC secret for gateway-to-ZernFlow event delivery;
- a scheduler that invokes the protected cron routes;
- optional AI Gateway credentials for AI Response nodes.

Postiz is configured behind Agent Social Gateway, not in the browser and not in ZernFlow workspace rows.

## Local setup

```bash
git clone https://forgejo.tca-infraforge.site/temitayocharles/zernflow.git
cd zernflow
git checkout feature/foundation-gateway-seam
npm ci
cp .env.example .env.local
```

Populate `.env.local` with server-side values from `.env.example`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

SOCIAL_GATEWAY_BASE_URL=https://gateway.example.com
SOCIAL_GATEWAY_API_KEY=replace-with-operator-api-key-at-least-24-characters
SOCIAL_GATEWAY_ADMIN_API_KEY=replace-with-admin-api-key-at-least-24-characters
SOCIAL_GATEWAY_ACTOR_REF=zernflow
SOCIAL_GATEWAY_WORKSPACE_REF=default
SOCIAL_GATEWAY_TIMEOUT_MS=10000
SOCIAL_GATEWAY_WEBHOOK_SECRET=replace-with-random-webhook-secret-at-least-24-characters

CRON_SECRET=replace-with-random-cron-secret-at-least-24-characters
NEXT_PUBLIC_APP_URL=http://localhost:3000
ENABLE_LEGACY_ZERNIO=false
```

Never prefix gateway credentials, the service-role key, cron secret or webhook secret with `NEXT_PUBLIC_`.

## Database migrations

The numbered files in `supabase/migrations/` are the only migration source of truth. Apply every numbered migration in lexical order, currently `00001` through `00020`.

For a linked Supabase project, use the Supabase CLI migration workflow. For a manual installation, execute each numbered SQL file in order and record the applied revision outside the application database if your deployment system does not do so automatically.

Do not concatenate or selectively copy migrations. Migrations 16 through 20 contain the configuration hardening, gateway conversation identity, durable gateway webhook ledger and event-time inbox projection required by the current runtime.

See `supabase/migrations/README.md` for the production procedure and verification queries.

## Run and validate

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run dev
```

The canonical Forgejo CI uses Node 24 and requires all of the following:

- production dependency audit with no high-severity findings;
- ESLint;
- strict TypeScript compilation;
- the Vitest suite;
- a successful Next.js production build.

## Gateway event delivery

Configure an active Agent Social Gateway delivery webhook endpoint for:

```text
https://<zernflow-host>/api/webhooks/social-gateway
```

The endpoint must subscribe to the required provider-neutral events, including `message.received`, `comment.received`, `reply.received` and `message.delivery_status` as appropriate. Its `secret_ref` must resolve in Vault to a value named `WEBHOOK_SECRET`. The resolved value must equal `SOCIAL_GATEWAY_WEBHOOK_SECRET` in the ZernFlow runtime.

The gateway signs the exact request body with HMAC-SHA256 and sends stable event and delivery identities in request headers. ZernFlow verifies the signature and timestamp, resolves the projected channel by gateway account UUID, atomically records the event and schedules durable local processing. Duplicate gateway events do not execute a flow twice.

## Scheduled execution

Invoke these routes with `Authorization: Bearer <CRON_SECRET>`:

```text
GET /api/cron/jobs
GET /api/cron/sequences
```

Use a cadence appropriate to the deployment platform. The job route performs claim compare-and-swap, stale-claim recovery, bounded retries and terminal settlement for delayed flows, broadcasts and queued gateway events.

## Security model

- provider and gateway secrets are server-only;
- browser-supplied provider API keys are not accepted;
- service-role access is restricted to server routes and cron workers;
- gateway webhook requests have a one-megabyte body limit and five-minute replay window;
- gateway outbound operations use stable idempotency keys;
- sensitive gateway actions use the admin or dedicated agent credential rather than the general operator credential;
- legacy Zernio access fails closed by default;
- official provider API restrictions remain authoritative.

## Important compatibility aliases

The existing database columns `channels.late_account_id` and `conversations.late_conversation_id` currently store Agent Social Gateway account and conversation IDs. They are retained temporarily to avoid a second migration of working business logic. New code should treat them as gateway identity aliases, not hosted-provider ownership.

## Repository structure

```text
app/
  api/webhooks/social-gateway/   signed gateway receiver
  api/cron/jobs/                 durable scheduled-job executor
  api/cron/sequences/            sequence scheduler
  api/v1/                        operator API routes
components/                      dashboard, inbox and flow-builder UI
lib/social-gateway/              provider-neutral client and webhook contracts
lib/flow-engine/                 flow execution and gateway message dispatch
lib/supabase/                    server, browser and middleware clients
supabase/migrations/             ordered schema migrations
```

## Related repository

Agent Social Gateway:

```text
https://forgejo.tca-infraforge.site/temitayocharles/agent-social-gateway
```

## License

MIT
