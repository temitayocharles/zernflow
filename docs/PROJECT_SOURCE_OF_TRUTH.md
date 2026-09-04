# Project Source of Truth

Last updated: 2026-09-03

ZernFlow is the operator-facing application repository within the self-hosted omnichannel customer and digital-operations product. The authoritative cross-repository product definition, architecture decisions, roadmap, current state, capability-gap inventory, and continuation procedure are maintained in `temitayocharles/agent-social-gateway`:

- `docs/CANONICAL_PRODUCT_SOURCE_OF_TRUTH.md`
- `docs/ADR-0002-POSTIZ-RETIREMENT.md`
- `docs/DELIVERY_ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `docs/OMNICHANNEL_CRM_CAPABILITY_GAP_REGISTER.md`
- `docs/CONTINUATION_PROTOCOL.md`

These documents define:

- the product as an omnichannel CRM, engagement, publishing, service-desk, and human/AI agent workspace, not merely a social automation tool;
- ZernFlow as the operator-facing product shell;
- Agent Social Gateway as the authoritative provider/connector, action, policy, event, and durable-operation backend;
- Northflank as the permanent always-on runtime;
- application-driven OAuth, token, maintained-plugin, generic-connector, email, and controlled browser-session onboarding;
- Vault-backed credentials and sensitive session references without per-account ESO changes or pod restarts;
- configurable Allow, Ask, Deny, and Allow-with-limit agent controls;
- connector-first delivery that prefers maintained integrations before bespoke native provider code, except components already marked for retirement;
- controlled browser-session connectors for unsupported personal/internal workflows such as Facebook personal profile or selected TikTok operations where permitted, without bypassing CAPTCHA, MFA, anti-bot controls, or provider security mechanisms;
- CRM, service-desk/ticket, SLA, Kanban, email, publishing, support analytics, SEO/content analytics, conversion, revenue-attribution, and knowledge/RAG gaps that still need implementation;
- dependency-ordered delivery and real end-to-end acceptance criteria;
- Postiz as transitional legacy infrastructure that must be retired after replacement publishing/calendar/media capability is accepted and migrated safely.

`ADR-0002-POSTIZ-RETIREMENT.md` is explicit: Postiz is not a steady-state optional adapter and must not receive new strategic product dependencies. Existing Postiz behavior may be used temporarily only to preserve compatibility and rollback while replacement paths are certified. A future reversal requires a new accepted ADR.

Before implementing or changing ZernFlow, read the canonical documents and accepted ADRs and inspect the current Gateway and ZernFlow heads, active issues, pull requests, migrations, deployments, n8n capabilities, maintained connectors, and any existing Postiz-backed behavior that must be preserved during migration. Inspect Postiz only for migration requirements, existing behavior, and regression risk. Do not select it as the target implementation for new provider work. Do not create a parallel dashboard, provider backend, conversation ledger, action ledger, ticket ledger, or duplicate integration merely because a platform is desired.

A platform name appearing in ZernFlow does not prove that the platform is supported end to end. Support claims require real connector capability and acceptance evidence.

## ZernFlow-specific ownership

ZernFlow owns the operator experience and provider-neutral customer/work projections, including:

- authentication and workspaces;
- dashboard and navigation;
- channel/connector connection experience;
- unified inbox presentation;
- contacts, identity projection, tags, custom fields, segments, companies, lifecycle, and CRM views;
- visual flows, broadcasts, and sequences;
- work items such as tickets, tasks, incidents, follow-ups, and content cards;
- queues, human/agent assignment, priorities, SLA presentation, escalation, and Kanban/list views;
- contact, company, conversation, ticket, deal, campaign, and activity cross-linking;
- publishing/editorial coordination surfaces while reusing maintained non-retiring publishing/calendar/media components where appropriate and preserving Postiz only temporarily during replacement/migration;
- support, CRM, content, SEO, conversion, revenue, and agent/team analytics presentation where reliable data exists;
- team, agent-control, approval, takeover, handoff, and activity UI;
- responsive local projections of Gateway-owned data.

## Build-versus-plug rule

Before adding provider-specific code to ZernFlow, evaluate:

1. an existing maintained connector or deployed product adapter that is not marked for retirement;
2. the official provider API/OAuth path;
3. a generic API/webhook/email/standards connector;
4. the controlled browser-session connector for unsupported personal/internal workflows where permitted;
5. a new native adapter only when previous options cannot satisfy the requirement.

Postiz is excluded as a steady-state choice by `ADR-0002-POSTIZ-RETIREMENT.md`. When a current capability still runs through Postiz, preserve it only until a replacement is accepted, migrate required state safely, maintain rollback during transition, then remove the Postiz dependency and retire the corresponding runtime/resources.

ZernFlow should consume connector capability metadata from Agent Social Gateway rather than hard-code every provider's behavior into the frontend.

Conflicting historical ZernFlow documentation, issue text, PR descriptions, or chat history must defer to the canonical cross-repository package and accepted ADRs.
