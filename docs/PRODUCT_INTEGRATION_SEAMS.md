# Product integration seams

## Ownership and truthful states

Migrations 00021–00024 persist ZernFlow-owned CRM, work items, operator notes,
notifications, editorial planning, knowledge-source references and mailbox sender
identities. They do not create a second provider message/action/event ledger,
credential vault, scheduler, email backend, or RAG engine. No Postiz dependency
was added. Existing broadcasts and provider execution paths remain unchanged.

## Knowledge retrieval contract

An optional external service may implement `lib/knowledge/contracts.ts` at the
complete HTTPS endpoint configured in `KNOWLEDGE_RETRIEVAL_URL`, authenticated
with server-only `KNOWLEDGE_API_TOKEN`. This is a **new replaceable integration
seam**, not a claim about an existing Gateway endpoint.

POST body: `{ workspaceRef, query, sourceRefs, limit }`.
Response: `{ requestId, indexingStatus, citations }`; indexingStatus is
`ready | partial | indexing | unknown`; each citation contains
`sourceRef, title, excerpt, url: string | null, score: number | null`.

The service must authorize source refs within workspaceRef. ZernFlow validates
local membership, enabled source selection, and returned source references.
Server requests do not follow redirects, time out at ten seconds, and bound
responses at one megabyte. Citation URLs allow only HTTP(S); excerpts are rendered
as escaped text. Indexing is external; configuring/enabling a source does not
claim it is indexed. There is no persisted retrieval-answer ledger.

## Email

`lib/email/contracts.ts` defines mailbox/thread/message identities, recipients,
subject, text/HTML bodies, attachment metadata, delivery state, outbound reply
and adapter contracts. Replies preserve thread identity and do not implicitly
reply-all. HTML is not injected into the application DOM. Mailbox identity rows
contain no credentials and are not evidence of a connected email channel.
Gateway account onboarding, inbound projection and dispatch require the real
email connector contract before enabling live inbox email behavior.

## Publishing

Local editorial drafts support owner approval, requested schedule/timezone,
campaign grouping, per-channel variants and external media references. Content,
schedule or variant changes invalidate prior approval. Approved is **not sent**;
requested schedule is **not a queued job**. The DB rejects provider execution
states in local drafts. `PublishingExecutor` describes the replaceable handoff
for a verified Gateway/maintained connector; it is not wired to speculative
endpoints. Per-channel outcomes represent real externally supplied operations,
not synthetic success. No uploads or provider retries are fabricated.

## Browser connectors

`lib/connectors/browser-session.ts` models human login, MFA, security challenges,
expiry, revocation, health and explicit capabilities. Operations fail closed
unless health, permitted use, unexpired session and capability are all present.
No browser automation or security-control bypass is implemented.

## Collaboration

Existing client assignment/escalation/takeover methods are wired through local
conversation authorization and trusted server-side actor identity. UI displays
only the last confirmed action result; live control reads/presence are not
invented. Approval execution methods remain unexposed until an authorized
request-to-workspace read contract exists. Policy/approval projections describe
unavailable state honestly; local preferences cannot bypass Gateway enforcement.
