# Project Source of Truth

Last updated: 2026-09-03

ZernFlow is the operator-facing application repository within the self-hosted omnichannel customer and digital-operations product. The authoritative cross-repository product definition, roadmap, current state, capability-gap inventory, and continuation procedure are maintained in `temitayocharles/agent-social-gateway`:

- `docs/CANONICAL_PRODUCT_SOURCE_OF_TRUTH.md`
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
- connector-first delivery that prefers maintained integrations before bespoke native provider code;
- controlled browser-session connectors for unsupported personal/internal workflows such as Facebook personal profile or selected TikTok operations where permitted, without bypassing CAPTCHA, MFA, anti-bot controls, or provider security mechanisms;
- CRM, service-desk/ticket, SLA, Kanban, email, publishing, support analytics, SEO/content analytics, conversion, revenue-attribution, and knowledge/RAG gaps that still need implementation;
- dependency-ordered delivery and real end-to-end acceptance criteria.

Before implementing or changing ZernFlow, read the canonical documents and inspect the current Gateway and ZernFlow heads, active issues, pull requests, migrations, deployments, existing Postiz/n8n capabilities, and maintained connectors. Do not create a parallel dashboard, provider backend, conversation ledger, action ledger, ticket ledger, or duplicate integration merely because a platform is desired.

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
- publishing/editorial coordination surfaces while reusing maintained publishing/calendar/media components where appropriate;
- support, CRM, content, SEO, conversion, revenue, and agent/team analytics presentation where reliable data exists;
- team, agent-control, approval, takeover, handoff, and activity UI;
- responsive local projections of Gateway-owned data.

## Build-versus-plug rule

Before adding provider-specific code to ZernFlow, evaluate:

1. an existing maintained connector or deployed product adapter;
2. the official provider API/OAuth path;
3. a generic API/webhook/email/standards connector;
4. the controlled browser-session connector for unsupported personal/internal workflows where permitted;
5. a new native adapter only when previous options cannot satisfy the requirement.

ZernFlow should consume connector capability metadata from Agent Social Gateway rather than hard-code every provider's behavior into the frontend.

Conflicting historical ZernFlow documentation, issue text, PR descriptions, or chat history must defer to the canonical cross-repository package.
