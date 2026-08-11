# ZernFlow Supabase Isolation

ZernFlow production uses its own Supabase project. The application schema is the project's `public` schema; the prior `omni_channel` client schema override existed only to isolate ZernFlow data inside the formerly shared Sivanta Supabase project and must not be restored.

Production Supabase project reference: `pamemznxfsuouiajusoj`.

The numbered migrations in `supabase/migrations/` remain the database source of truth and are applied to `public` in lexical order.

Northflank secret group `zernflow-runtime` must remain restricted to service `zernflow` only. Sivanta and Agent Social Gateway must not inherit ZernFlow Supabase credentials.
