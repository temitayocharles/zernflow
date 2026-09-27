import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

/**
 * PostgreSQL (PGlite) harness that mirrors Supabase privilege defaults
 * *before* migrations run: new tables/functions/sequences are granted to
 * anon/authenticated/service_role, exactly like a Supabase project. Revocations
 * performed by migrations are therefore observable in tests (the legacy
 * database.test.ts harness grants all tables after migrations, which would mask
 * them).
 */
export async function createMigratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create publication supabase_realtime;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create role authenticated nologin;
    create role anon nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public, auth to authenticated, anon, service_role;
    grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
  `);
  const files = readdirSync("supabase/migrations")
    .filter((f) => /^\d{5}_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    if (file.startsWith("00001")) sql = sql.replace('create extension if not exists "uuid-ossp";', "");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return db;
}

/** Execute statements as an authenticated end user (RLS + grants applied). */
export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`);
  }
}

/** Execute statements as the Supabase service role (bypasses RLS, grants still apply). */
export async function asService<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role service_role;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

export const ids = {
  wsA: "10000000-0000-4000-8000-00000000000a",
  wsB: "10000000-0000-4000-8000-00000000000b",
  ownerA: "20000000-0000-4000-8000-00000000000a",
  memberA: "20000000-0000-4000-8000-0000000000a2",
  ownerB: "20000000-0000-4000-8000-00000000000b",
};

/** Two workspaces, an owner and a member in A, an owner in B. Runs as superuser. */
export async function seedTenants(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users(id,email) values
      ('${ids.ownerA}','a@example.test'),('${ids.memberA}','a2@example.test'),('${ids.ownerB}','b@example.test');
    delete from workspace_members; delete from workspaces;
    insert into workspaces(id,name,slug) values ('${ids.wsA}','A','a'),('${ids.wsB}','B','b');
    insert into workspace_members(workspace_id,user_id,role) values
      ('${ids.wsA}','${ids.ownerA}','owner'),('${ids.wsA}','${ids.memberA}','member'),('${ids.wsB}','${ids.ownerB}','owner');
  `);
}
