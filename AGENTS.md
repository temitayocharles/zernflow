# AGENTS.md

## Workspace governance inheritance

This repository inherits the current Tayoca / InfraForge workspace governance contract from `temitayocharles/ai-workspace-control` and current Notion operating authority.

Resolve authority before material work in this order: current Notion authority → verified live/source-system truth → workspace governance → this repository contract → nearest nested `AGENTS.md`.

## Product and ownership boundary

ZernFlow is the operator/workflow layer for the self-hosted Omnichannel Agent Operations Platform.

ZernFlow owns operator-facing flows, projected inbox/contact state, assignments, human takeover, approval-oriented automation configuration, sequences, broadcasts, scheduled jobs, and its local signed gateway-event processing ledger.

Agent Social Gateway owns provider accounts, OAuth/token lifecycle, Vault-backed provider credentials, authoritative normalized messages/conversations, durable outbound operations, provider policy, connector capability, and REST/MCP execution contracts.

- Do not move provider credentials or authoritative provider-message storage into ZernFlow.
- Do not accept browser-supplied provider secrets.
- Do not add new strategic Postiz dependencies. Transitional compatibility must stay behind the gateway boundary.
- Expose provider actions only when current gateway capability and live acceptance evidence support them.
- Editorial approval is not publication; mailbox configuration is not provider connectivity; knowledge-source configuration is not proof of indexing.

## Data, secrets, and migrations

- Never commit Supabase service-role keys, gateway API keys, webhook secrets, cron secrets, provider credentials, tokens, database URLs, cookies, signed URLs, or production `.env` files.
- Keep privileged credentials server-only. Never prefix secrets with `NEXT_PUBLIC_`.
- The numbered files in `supabase/migrations/` are the database migration source. Preserve lexical ordering and do not concatenate/selectively copy migrations.
- Preserve tenant isolation, idempotency, replay protection, bounded retries, durable claims, and human-approval boundaries.
- Treat production database migration and provider-routing changes as high-impact changes requiring explicit verification and rollback planning.

## Change discipline

1. Read `README.md`, `docs/PRODUCT_INTEGRATION_SEAMS.md`, `docs/LOCAL_VALIDATION.md`, and relevant gateway/migration docs before material changes.
2. Verify current Agent Social Gateway contracts and live capability when a change depends on provider behavior.
3. Reuse `shared-workflows` for reusable CI/CD and `utilities-scripts` for generic reusable operational scripts.
4. Use a feature branch and reviewed PR on the currently authoritative forge. Required pull-request checks must pass on the PR event; a successful branch push does not substitute for the protected PR status context. If a required PR check fails transiently while the exact-head validation is otherwise green, retrigger the protected PR context and diagnose repeated failure instead of force-merging.
5. For application changes run the relevant baseline: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
6. For migration changes, validate migration order and the affected tenant/security contracts in addition to application gates.
7. Record estate-wide authority changes, production incidents, and cross-agent continuation points in Notion rather than freezing them into permanent repo instructions.

If this contract conflicts with newer Notion/live/workspace authority, follow the newer authority and repair the stale repository instruction in the same reviewed change when appropriate.
