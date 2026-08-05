# Project Source of Truth

ZernFlow is one application repository within the self-hosted omnichannel product. The authoritative cross-repository product definition, roadmap, current state, and continuation procedure are maintained in `temitayocharles/agent-social-gateway`:

- `docs/CANONICAL_PRODUCT_SOURCE_OF_TRUTH.md`
- `docs/DELIVERY_ROADMAP.md`
- `docs/CONTINUATION_PROTOCOL.md`
- `docs/CURRENT_STATE.md`

These documents define:

- Zernio-level ease and capability parity as the primary benchmark;
- ZernFlow as the operator-facing product shell;
- Agent Social Gateway as the self-hosted replacement for Zernio's hosted provider backend;
- Northflank as the permanent always-on runtime;
- runtime OAuth and token onboarding through the application;
- Vault-backed credentials without per-account ESO changes or pod restarts;
- configurable Allow, Ask, Deny, and Allow-with-limit agent controls;
- dependency-ordered delivery and end-to-end acceptance criteria.

Before implementing or changing ZernFlow, read the canonical documents and inspect the current Gateway and ZernFlow heads, active issues, pull requests, migrations, and deployments. Do not create a parallel dashboard, provider backend, conversation ledger, or action ledger.

ZernFlow-specific ownership remains:

- authentication and workspaces;
- dashboard and navigation;
- channel connection experience;
- unified inbox presentation;
- contacts and CRM projection;
- visual flows, broadcasts, and sequences;
- analytics presentation;
- team, agent-control, approval, escalation, and activity UI;
- responsive local projections of Gateway-owned data.

Conflicting historical ZernFlow documentation, issue text, PR descriptions, or chat history must defer to the canonical cross-repository package.