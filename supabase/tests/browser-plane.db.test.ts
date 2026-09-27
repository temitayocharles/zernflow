import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
let sessionId: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  const { rows } = await db.query<{ id: string }>(
    `insert into browser_sessions(workspace_id,platform,label) values ('${ids.wsA}','instagram','Brand') returning id`,
  );
  sessionId = rows[0].id;
}, 120_000);
afterAll(async () => db?.close());

describe("browser plane (00035)", () => {
  it("accepts the unverified state and keeps unknown states out", async () => {
    await db.exec(`update browser_sessions set status='unverified' where id='${sessionId}'`);
    await expect(db.exec(`update browser_sessions set status='pwned' where id='${sessionId}'`)).rejects.toThrow(/check/);
  });

  it("experimental opt-in requires the permitted-use attestation", async () => {
    await expect(db.exec(`update browser_sessions set allow_experimental=true where id='${sessionId}'`)).rejects.toThrow(/experimental_needs_attestation/);
    await db.exec(`update browser_sessions set permitted_use_confirmed=true, permitted_use_confirmed_by='${ids.ownerA}', permitted_use_confirmed_at=now(), allow_experimental=true where id='${sessionId}'`);
  });

  it("platform is immutable and revoked sessions cannot get a new state", async () => {
    await expect(db.exec(`update browser_sessions set platform='facebook' where id='${sessionId}'`)).rejects.toThrow(/immutable/);
    await db.exec(`update browser_sessions set status='revoked' where id='${sessionId}'`);
    const { rows } = await db.query<{ id: string }>(`insert into secrets(workspace_id,name,kind) values ('${ids.wsA}','bs','browser_session_state') returning id`);
    await expect(db.exec(`update browser_sessions set storage_state_secret_id='${rows[0].id}' where id='${sessionId}'`)).rejects.toThrow(/revoked/);
  });

  it("owners read worker capabilities (never token hashes); members read sessions but never write", async () => {
    await db.exec(`insert into worker_identities(workspace_id,name,token_hash,token_prefix,capabilities,version) values ('${ids.wsA}','browser','${"a".repeat(64)}','zfw_abcd','{"adapters":["instagram:session_check"]}','0.1.0')`);
    await asUser(db, ids.ownerA, async () => {
      const { rows } = await db.query<{ capabilities: unknown; version: string }>("select capabilities, version from worker_identities");
      expect(rows[0]).toMatchObject({ version: "0.1.0" });
    });
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query("select token_hash from worker_identities")).rejects.toThrow(/permission denied/);
    });
    await asUser(db, ids.memberA, async () => {
      expect((await db.query("select id from worker_identities")).rows).toHaveLength(0);
      expect((await db.query("select id from browser_sessions")).rows).toHaveLength(1);
    });
    await asUser(db, ids.memberA, async () => {
      await expect(db.exec(`update browser_sessions set allow_experimental=false`)).rejects.toThrow(/permission denied/);
    });
    await asUser(db, ids.ownerB, async () => {
      expect((await db.query("select id from browser_sessions")).rows).toHaveLength(0);
      expect((await db.query("select id from worker_identities")).rows).toHaveLength(0);
    });
  });
});
