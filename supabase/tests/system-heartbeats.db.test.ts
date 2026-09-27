import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

type Db = Awaited<ReturnType<typeof createMigratedDatabase>>;
let db: Db;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
}, 120_000);
afterAll(async () => db?.close());

describe("system heartbeats", () => {
  it("service records heartbeats and keeps last_ok_at across failures", async () => {
    await asService(db, async () => {
      await db.query(`select record_heartbeat('tick', 'ok', 120, '{"failedStages":[]}')`);
      await db.query(`select record_heartbeat('tick', 'degraded', 300, '{"failedStages":["tasks"]}')`);
    });
    const { rows } = await db.query<{ status: string; last_ok_at: string | null; detail: { failedStages: string[] } }>(
      "select status, last_ok_at, detail from system_heartbeats where component = 'tick'",
    );
    expect(rows[0]).toMatchObject({ status: "degraded", detail: { failedStages: ["tasks"] } });
    expect(rows[0].last_ok_at).not.toBeNull();
  });

  it("signed-in users can read but never write or call the recorder", async () => {
    await asUser(db, ids.memberA, async () => {
      const { rows } = await db.query("select component from system_heartbeats");
      expect(rows).toHaveLength(1);
      await expect(db.query(`insert into system_heartbeats(component, last_run_at, status) values ('fake', now(), 'ok')`)).rejects.toThrow();
    });
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select record_heartbeat('tick', 'ok', 1, '{}')`)).rejects.toThrow(/permission denied/);
    });
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`update system_heartbeats set status = 'ok'`)).rejects.toThrow();
    });
  });

  it("rejects malformed component names and oversized detail", async () => {
    await asService(db, async () => {
      await expect(db.query(`select record_heartbeat('Bad Name!', 'ok', 1, '{}')`)).rejects.toThrow();
    });
    await asService(db, async () => {
      await expect(db.query(`select record_heartbeat('big', 'ok', 1, jsonb_build_object('x', repeat('a', 5000)))`)).rejects.toThrow();
    });
  });
});
