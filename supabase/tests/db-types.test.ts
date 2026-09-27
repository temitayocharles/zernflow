import { readFileSync, writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "@/lib/test/pg-harness";
import { generateDatabaseTypes } from "@/lib/test/db-typegen";

/**
 * Keeps lib/types/database.generated.ts in lockstep with the migrations.
 * The compile-time drift check between the hand-maintained app contract
 * (lib/types/database.ts) and these generated types lives in
 * lib/types/database-drift.ts and runs under `tsc`.
 */
const TARGET = "lib/types/database.generated.ts";
let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDatabase();
}, 60000);
afterAll(async () => db?.close());

describe("generated database types", () => {
  it("match the migrations (run `npm run db:types` after adding a migration)", async () => {
    const generated = await generateDatabaseTypes(db);
    if (process.env.UPDATE_DB_TYPES === "1") writeFileSync(TARGET, generated);
    const committed = readFileSync(TARGET, "utf8");
    expect(committed === generated, `${TARGET} is stale; run npm run db:types`).toBe(true);
  });
});
