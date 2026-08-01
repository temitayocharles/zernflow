# Self-Hosted Omnichannel Control Plane Roadmap

Status: active
Baseline upstream snapshot: `e8a0a16f2de46b86e506edbfe06c192f3cb1390a`

## Product boundary

ZernFlow is the operator shell for inbox, contacts, teams, human takeover, visual flows, broadcasts and sequences. Agent Social Gateway is the provider control plane for account onboarding, OAuth, credential references, webhooks, normalized events, durable actions, policy and Hermes MCP. n8n owns recurring/background orchestration. Vault owns provider and AI secrets. Postiz is not a dependency and will be removed from infrastructure.

## Execution protocol

Work proceeds milestone by milestone. Every milestone must include tests, immutable evidence, cleanup of superseded code/resources and an updated delivery ledger before the next milestone starts. A provider is not supported until a live non-destructive acceptance test passes.

## Milestone 0 — Baseline and supply-chain safety

- [x] Create controlled fork with upstream linkage.
- [x] Reproduce install, tests, lint and production build.
- [x] Record hosted-Zernio seams and secret-bearing fields.
- [ ] Commit safe dependency upgrades and resolve remaining production advisories.
- [ ] Add CI for test, lint, build and production dependency audit.
- [ ] Mirror the fork to Forgejo and make Forgejo authoritative.

Exit gate: reproducible CI passes and no unreviewed high-severity production finding remains.

## Milestone 1 — Provider-neutral client seam

- [ ] Define `SocialGatewayClient` interfaces for accounts, conversations, messages, comments, webhooks and capabilities.
- [ ] Add a compatibility adapter implementing those interfaces through the current Zernio SDK.
- [ ] Refactor routes, inbox sync, flow nodes, sequences and comment processing to depend only on the interface.
- [ ] Add contract tests proving the adapter preserves behavior.

Exit gate: no application module imports `@zernio/node` outside the compatibility adapter.

## Milestone 2 — Remove secret storage from workspaces

- [ ] Add non-secret gateway connection records and provider-neutral external IDs.
- [ ] Remove `late_api_key_encrypted`, workspace webhook secrets and AI secret values from operator-readable rows.
- [ ] Store provider/AI secret material in Vault and keep only references in the backend.
- [ ] Add owner/admin/member RBAC and tighten RLS policies.
- [ ] Add signed, replay-protected service authentication.

Exit gate: database dumps and client responses contain no provider or AI credentials.

## Milestone 3 — Gateway account and OAuth plane

- [ ] Add provider applications, provider accounts, capabilities and lifecycle state.
- [ ] Implement OAuth initiation, callback, refresh, revocation and disconnect.
- [ ] Implement webhook registration, subscription health and token-expiry monitoring.
- [ ] Replace global gateway tokens with per-account Vault resolution.
- [ ] Add account and capability APIs used by the ZernFlow shell.

Exit gate: one real account connects without a Zernio key and remains healthy through token refresh.

## Milestone 4 — Durable event and action plane

- [ ] Add transactional outbox, provider workers, bounded retry and rate-limit scheduling.
- [ ] Add reconciliation for ambiguous outcomes.
- [ ] Add immutable event/action audit and ownership transitions.
- [ ] Add media/attachment object storage.
- [ ] Add provider capability and messaging-window enforcement.

Exit gate: restart and duplicate-delivery tests prove no duplicate external action.

## Milestone 5 — Agent and human control plane

- [ ] Add per-agent identities, scopes and tool grants.
- [ ] Add draft, approve, reject, assign, escalate and handoff operations.
- [ ] Add policy rules based on provider, risk, contact, message type and confidence.
- [ ] Expand Hermes MCP tools for controlled live participation.
- [ ] Stream safe realtime status into the operator inbox.

Exit gate: Hermes can act under policy and a human can take over without losing context.

## Milestone 6 — Provider vertical slices

Complete each provider end to end before starting the next:

1. Telegram.
2. Meta: Facebook Pages, Instagram and WhatsApp where approved.
3. YouTube comments and replies.
4. LinkedIn organization comments after approval.
5. Reddit after approved API access.
6. X only after usage pricing is accepted.
7. TikTok according to approved products.

Each slice includes onboarding, credential lifecycle, webhook or poll ingestion, normalization, outbound actions, media, capabilities, quotas, policy constraints, tests and a live acceptance record.

## Milestone 7 — Infrastructure and Postiz removal

- [ ] Remove the Postiz Argo application and manifests.
- [ ] Delete Postiz workloads and its unshared Temporal, Redis and database resources.
- [ ] Remove Postiz secrets and Vault paths after dependency verification.
- [ ] Reclaim persistent volumes after confirming no required data.
- [ ] Deploy ZernFlow, gateway workers, Supabase-compatible services and object storage through GitOps.
- [ ] Add backups, observability, resource limits and disaster-recovery tests.

Exit gate: no live Postiz resource remains and the replacement stack passes end-to-end acceptance.

## Final acceptance

- runs without a Zernio or Postiz key;
- connects a real provider account;
- displays a real inbound event in the inbox;
- lets Hermes act through scoped tools;
- supports assignment and human takeover;
- records a complete audit trail;
- survives restart without duplicate actions;
- keeps provider secrets in the approved secret boundary.
