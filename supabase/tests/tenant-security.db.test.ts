import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
const chA = "40000000-0000-4000-8000-00000000000a";
const chB = "40000000-0000-4000-8000-00000000000b";
const contactA = "50000000-0000-4000-8000-00000000000a";
const contactB = "50000000-0000-4000-8000-00000000000b";
const seqA = "60000000-0000-4000-8000-00000000000a";
const bcA = "70000000-0000-4000-8000-00000000000a";

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  await db.exec(`
    insert into channels(id,workspace_id,platform,late_account_id,webhook_secret) values
      ('${chA}','${ids.wsA}','telegram','gw-acct-a','legacy-secret-a'),
      ('${chB}','${ids.wsB}','telegram','gw-acct-b','legacy-secret-b');
    update workspaces set ai_api_key='sk-plaintext-a', late_api_key_encrypted='legacy-zernio-key' where id='${ids.wsA}';
    insert into contacts(id,workspace_id,display_name) values ('${contactA}','${ids.wsA}','A'),('${contactB}','${ids.wsB}','B');
    insert into sequences(id,workspace_id,name,status,steps) values ('${seqA}','${ids.wsA}','S','active','[]');
    insert into broadcasts(id,workspace_id,name,message_content) values ('${bcA}','${ids.wsA}','B1','{"text":"hi"}');
    insert into scheduled_jobs(type,payload,run_at) values
      ('process_social_gateway_event', jsonb_build_object('eventId','e1','channelId','${chB}','envelope','{}'::jsonb), now());
  `);
}, 60000);
afterAll(async () => db?.close());

describe("S1 scheduled_jobs is worker-only", () => {
  it("denies cross-tenant reads, forged inserts and updates for authenticated users", async () => {
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query("select * from scheduled_jobs")).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`insert into scheduled_jobs(type,payload,run_at) values ('process_social_gateway_event','{}',now())`),
      ).rejects.toThrow(/permission denied/);
      await expect(db.exec(`update scheduled_jobs set status='pending'`)).rejects.toThrow(/permission denied/);
    });
  });
  it("attributes jobs to their workspace from payload identity", async () => {
    const { rows } = await db.query<{ workspace_id: string }>(
      `select workspace_id from scheduled_jobs where payload->>'eventId'='e1'`,
    );
    expect(rows[0].workspace_id).toBe(ids.wsB);
  });
  it("has no client policies left", async () => {
    const { rows } = await db.query(`select 1 from pg_policies where tablename='scheduled_jobs'`);
    expect(rows).toHaveLength(0);
  });
});

describe("S9 broadcast scheduling RPC", () => {
  it("schedules idempotently for members, honoring scheduled_for", async () => {
    await db.exec(`insert into broadcast_recipients(broadcast_id,contact_id,channel_id) values ('${bcA}','${contactA}','${chA}')`);
    await db.exec(`update broadcasts set scheduled_for=now()+interval '1 day' where id='${bcA}'`);
    const first = await asUser(db, ids.memberA, () =>
      db.query<{ n: number }>(`select schedule_broadcast_delivery('${bcA}') as n`),
    );
    expect(first.rows[0].n).toBe(1);
    const { rows } = await db.query<{ status: string; total_recipients: number }>(
      `select status,total_recipients from broadcasts where id='${bcA}'`,
    );
    expect(rows[0]).toEqual({ status: "scheduled", total_recipients: 1 });
    const job = await db.query<{ future: boolean; workspace_id: string }>(
      `select run_at > now() + interval '23 hours' as future, workspace_id from scheduled_jobs where type='send_broadcast'`,
    );
    expect(job.rows[0]).toEqual({ future: true, workspace_id: ids.wsA });
    const again = await asUser(db, ids.memberA, () =>
      db.query<{ n: number }>(`select schedule_broadcast_delivery('${bcA}') as n`),
    );
    expect(again.rows[0].n).toBe(0);
  });
  it("refuses another workspace's broadcast", async () => {
    await asUser(db, ids.ownerB, async () => {
      await expect(db.query(`select schedule_broadcast_delivery('${bcA}')`)).rejects.toThrow(/unavailable/);
    });
  });
});

describe("S6 workspace consistency on legacy tables", () => {
  it("rejects foreign contacts/channels in enrollments, recipients, identities and conversations", async () => {
    await asUser(db, ids.ownerA, async () => {
      await expect(
        db.exec(`insert into sequence_enrollments(sequence_id,contact_id,channel_id) values ('${seqA}','${contactB}','${chB}')`),
      ).rejects.toThrow(/same workspace/);
      await expect(
        db.exec(`insert into broadcast_recipients(broadcast_id,contact_id,channel_id) values ('${bcA}','${contactB}','${chB}')`),
      ).rejects.toThrow(/same workspace/);
      await expect(
        db.exec(`insert into contact_channels(contact_id,channel_id,platform_sender_id) values ('${contactA}','${chB}','x')`),
      ).rejects.toThrow(/same workspace/);
    });
    await expect(
      db.exec(`insert into conversations(workspace_id,channel_id,contact_id,platform) values ('${ids.wsA}','${chB}','${contactA}','telegram')`),
    ).rejects.toThrow(/same workspace/);
  });
  it("still accepts consistent rows", async () => {
    await asUser(db, ids.ownerA, async () => {
      await db.exec(`insert into sequence_enrollments(sequence_id,contact_id,channel_id) values ('${seqA}','${contactA}','${chA}')`);
    });
  });
});

describe("S5 legacy secret columns are server-only", () => {
  it("denies browser roles the secret columns while allowing safe columns", async () => {
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query(`select ai_api_key from workspaces`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select late_api_key_encrypted from workspaces`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select webhook_secret from channels`)).rejects.toThrow(/permission denied/);
      const { rows } = await db.query<{ name: string }>(`select id,name,slug from workspaces`);
      expect(rows.map((r) => r.name)).toEqual(["A"]);
      await expect(db.exec(`update workspaces set ai_api_key='x' where id='${ids.wsA}'`)).rejects.toThrow(/permission denied/);
    });
  });
  it("keeps service-role access for server code", async () => {
    const { rows } = await asService(db, () =>
      db.query<{ ai_api_key: string }>(`select ai_api_key from workspaces where id='${ids.wsA}'`),
    );
    expect(rows[0].ai_api_key).toBe("sk-plaintext-a");
  });
});

describe("S2 gateway projection is single-tenant", () => {
  it("prevents projecting the same gateway account into two workspaces", async () => {
    await expect(
      db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsB}','telegram','gw-acct-a')`),
    ).rejects.toThrow(/duplicate key/);
  });
  it("denies browser roles direct channel projection inserts", async () => {
    await asUser(db, ids.ownerB, async () => {
      await expect(
        db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsB}','telegram','gw-acct-new')`),
      ).rejects.toThrow(/permission denied/);
    });
  });
  it("lets members read but never write bindings", async () => {
    await db.exec(`insert into gateway_workspace_bindings(gateway_workspace_ref,workspace_id) values ('default','${ids.wsA}')`);
    await asUser(db, ids.memberA, async () => {
      const { rows } = await db.query(`select * from gateway_workspace_bindings`);
      expect(rows).toHaveLength(1);
    });
    await asUser(db, ids.ownerB, async () => {
      expect((await db.query(`select * from gateway_workspace_bindings`)).rows).toHaveLength(0);
      await expect(
        db.exec(`insert into gateway_workspace_bindings(gateway_workspace_ref,workspace_id) values ('other','${ids.wsB}')`),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
