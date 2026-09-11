# Supabase migration runbook

The numbered SQL files in this directory are the only schema source of truth for ZernFlow. Apply every numbered migration exactly once and in lexical order.

Current required range:

```text
00001_initial_schema.sql
...
00027_atomic_work_updates.sql
```

Do not concatenate the files into an aggregate SQL script and do not selectively copy statements between migrations. Later migrations intentionally alter constraints, policies, indexes and security-definer functions established by earlier files.

## Supabase CLI deployment

Link the repository to the intended Supabase project, inspect the pending migration set and then push it:

```bash
supabase link --project-ref <project-ref>
supabase migration list
supabase db push
supabase migration list
```

The second `migration list` must show migrations `00001` through `00027` as applied to the remote project.

For a disposable local Supabase environment, rebuild from the complete numbered history:

```bash
supabase start
supabase db reset
```

Never run `db reset` against a production project.

## Manual SQL deployment

When the Supabase CLI cannot be used, execute each unapplied numbered file in lexical order through the SQL editor or an approved PostgreSQL migration runner. Record the applied filename, commit SHA, target project and execution timestamp in the deployment ledger.

Do not mark a deployment complete until the verification queries below pass.

## Required verification

### Migration objects

```sql
select to_regprocedure('public.is_workspace_owner(uuid)') as owner_guard;
select to_regprocedure(
  'public.claim_social_gateway_webhook(text,text,text,uuid,jsonb)'
) as gateway_claim_function;
select to_regprocedure(
  'public.apply_social_gateway_inbound_conversation(uuid,timestamptz,text,text)'
) as inbox_projection_function;
```

All three values must be non-null.

### Gateway projection columns

```sql
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'sequence_enrollments' and column_name in (
      'current_operation_id', 'operation_checks', 'last_error'
    ))
    or (table_name = 'scheduled_jobs' and column_name = 'dedupe_key')
    or (table_name = 'webhook_events' and column_name in (
      'source', 'delivery_id', 'event_type', 'status', 'attempt_count',
      'claimed_at', 'completed_at', 'last_error'
    ))
  )
order by table_name, column_name;
```

The result must contain all listed columns.

### Required indexes

```sql
select indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'conversations_workspace_gateway_id_uidx',
    'sequence_enrollments_gateway_operation_idx',
    'webhook_events_delivery_id_idx',
    'webhook_events_processing_idx',
    'scheduled_jobs_type_dedupe_key_idx'
  )
order by indexname;
```

The result must contain all five indexes.

### Configuration policy boundary

```sql
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('workspaces', 'channels')
order by tablename, policyname;
```

Workspace updates and channel inserts, updates and deletes must be owner-scoped. Ordinary workspace membership must not grant configuration mutation.

## Release requirement

A ZernFlow release that includes gateway-backed inbox, sequences, broadcasts or signed gateway webhooks is not production-ready unless the target database has applied migrations `00016` through `00020` in addition to the earlier schema history.


## Product-domain migrations 00021–00027

- 00021: companies, customer profiles, opportunities, internal notes, audit.
- 00022: reusable work items, queues, SLA snapshots and guarded transitions.
- 00023: conversation notes, mentions, canned replies, recipient notifications.
- 00024: editorial drafts/variants/approval, external knowledge refs, email identities.
- 00025: authorized whole-workspace operator metrics.
- 00026: immutable customer-profile contact identity, scoped teammate directory,
  member-departure reference cleanup.

Apply in order on an isolated Supabase project before promotion. Existing
migrations were not rewritten. The automated `lib/product/database.test.ts`
applies the complete history in PGlite PostgreSQL with Auth/publication fixtures
and a `uuid_generate_v4()` equivalent; it verifies RLS, composite foreign keys,
trigger behavior, audit attribution and aggregates, not live Auth/Realtime.

Additional verification:

```sql
select to_regclass('public.work_items'), to_regclass('public.companies'),
       to_regclass('public.operator_notifications');
select to_regprocedure('public.operator_metrics(uuid)'),
       to_regprocedure('public.workspace_operator_directory(uuid)');
select tablename, policyname, cmd from pg_policies
where schemaname='public' and tablename in
('companies','customer_profiles','deals','work_items','work_queues',
 'customer_notes','product_activity','operator_notifications','canned_replies',
 'editorial_drafts','editorial_variants','knowledge_sources','mailbox_identities');
```

Run authorization verification as ordinary authenticated users in two different
workspaces, not as service role. Audit inserts must be rejected from browser
credentials; another recipient's notifications must be invisible. Only owner
may configure knowledge/mailboxes or approve editorial drafts. Test stale
version conflicts and composite foreign keys from API and direct PostgREST.
No automatic down migration is provided: retain customer/work records when
rolling back application code, rather than destructively dropping tables.

- 00027: atomic membership-scoped, version-safe bulk work status/priority updates; no partial writes on conflict.
