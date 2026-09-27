import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
const chA = "c0000000-0000-4000-8000-00000000000a";
const chB = "c0000000-0000-4000-8000-00000000000b";
const campA = "ca000000-0000-4000-8000-00000000000a";
const draft = "d0000000-0000-4000-8000-00000000000a";
const variant = "e0000000-0000-4000-8000-00000000000a";
const future = () => new Date(Date.now() + 3600_000).toISOString();

async function one<T>(sql: string): Promise<T> {
  const { rows } = await db.query<T>(sql);
  return rows[0];
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  await db.exec(`
    insert into channels(id,workspace_id,platform,late_account_id) values
      ('${chA}','${ids.wsA}','instagram','acct-a'),('${chB}','${ids.wsB}','facebook','acct-b');
  `);
}, 60000);
afterAll(async () => db?.close());

describe("campaigns", () => {
  it("members create campaigns; channels must belong to the workspace; results are server-managed", async () => {
    await asUser(db, ids.memberA, async () => {
      await db.exec(`insert into campaigns(id,workspace_id,name,channel_ids,results) values ('${campA}','${ids.wsA}','Launch','{${chA}}','{"leads":99}')`);
      expect((await one<{ results: object }>(`select results from campaigns where id='${campA}'`)).results).toEqual({});
      await expect(db.exec(`insert into campaigns(workspace_id,name,channel_ids) values ('${ids.wsA}','Bad','{${chB}}')`)).rejects.toThrow(/belong to the workspace/);
      await expect(db.exec(`update campaigns set results='{"leads":1}' where id='${campA}'`)).rejects.toThrow(/server-managed/);
      await expect(db.exec(`delete from campaigns where id='${campA}'`)).rejects.toThrow(/permission denied/);
    });
    await asUser(db, ids.ownerB, async () => {
      expect((await db.query(`select 1 from campaigns`)).rows).toHaveLength(0);
      await expect(db.exec(`insert into campaigns(workspace_id,name) values ('${ids.wsA}','x')`)).rejects.toThrow(/row-level security/);
    });
  });
});

describe("publishing state machine", () => {
  beforeAll(async () => {
    await asUser(db, ids.memberA, async () => {
      await db.exec(`insert into editorial_drafts(id,workspace_id,name,body,campaign_id) values ('${draft}','${ids.wsA}','Teaser','Hello','${campA}')`);
      await db.exec(`insert into editorial_variants(id,workspace_id,draft_id,channel_id,body) values ('${variant}','${ids.wsA}','${draft}','${chA}','Hello IG')`);
    });
  });

  it("clients cannot set publish state or forge variants as published", async () => {
    await asUser(db, ids.ownerA, async () => {
      await expect(db.exec(`update editorial_variants set publish_state='published' where id='${variant}'`)).rejects.toThrow(/managed by the scheduler/);
      const d3 = "d0000000-0000-4000-8000-00000000000c";
      await db.exec(`insert into editorial_drafts(id,workspace_id,name) values ('${d3}','${ids.wsA}','Forge')`);
      const forged = await one<{ publish_state: string; external_url: string | null }>(
        `insert into editorial_variants(workspace_id,draft_id,channel_id,body,publish_state,external_url)
         values ('${ids.wsA}','${d3}','${chA}','dup','published','https://evil.example') returning publish_state, external_url`,
      );
      expect(forged).toEqual({ publish_state: "draft", external_url: null });
    });
  });

  it("requires owner approval when the campaign requires it", async () => {
    await asUser(db, ids.memberA, async () => {
      await expect(
        db.query(`select schedule_content_item('${draft}','${future()}','[{"variantId":"${variant}","mode":"manual"}]'::jsonb)`),
      ).rejects.toThrow(/approval is required/);
    });
    await asUser(db, ids.memberA, () => db.exec(`update editorial_drafts set state='in_review' where id='${draft}'`));
    await asUser(db, ids.ownerA, () => db.exec(`update editorial_drafts set state='approved' where id='${draft}'`));
  });

  it("schedules idempotently into durable tasks without resetting approval", async () => {
    const at = future();
    await asUser(db, ids.memberA, async () => {
      const r = await one<{ n: number }>(`select schedule_content_item('${draft}','${at}','[{"variantId":"${variant}","mode":"manual"}]'::jsonb) as n`);
      expect(r.n).toBe(1);
    });
    const v = await one<{ publish_state: string; task_id: string; execution_mode: string }>(`select * from editorial_variants where id='${variant}'`);
    expect(v).toMatchObject({ publish_state: "scheduled", execution_mode: "manual" });
    const t = await one<{ state: string; execution_mode: string; kind: string; campaign_id: string }>(`select * from tasks where id='${v.task_id}'`);
    expect(t).toMatchObject({ state: "queued", execution_mode: "human", kind: "content.publish", campaign_id: campA });
    expect((await one<{ state: string }>(`select state from editorial_drafts where id='${draft}'`)).state).toBe("approved");
    // Scheduled content is locked.
    await asUser(db, ids.memberA, async () => {
      await expect(db.exec(`update editorial_variants set body='changed' where id='${variant}'`)).rejects.toThrow(/unschedule/);
      await expect(db.exec(`update editorial_drafts set body='changed' where id='${draft}'`)).rejects.toThrow(/unschedule/);
      await expect(db.query(`select schedule_content_item('${draft}','${at}','[{"variantId":"${variant}","mode":"manual"}]'::jsonb)`)).rejects.toThrow(/already scheduled/);
    });
  });

  it("other tenants cannot schedule, unschedule or confirm", async () => {
    await asUser(db, ids.ownerB, async () => {
      await expect(db.query(`select unschedule_content_item('${draft}')`)).rejects.toThrow(/unavailable/);
      await expect(db.query(`select confirm_manual_publication('${variant}','https://instagram.com/p/1')`)).rejects.toThrow(/unavailable/);
    });
  });

  it("confirms a manual publication, completing the task through legal transitions", async () => {
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select confirm_manual_publication('${variant}','http://insecure')`)).rejects.toThrow(/https/);
      await db.query(`select confirm_manual_publication('${variant}','https://instagram.com/p/abc','abc')`);
    });
    const v = await one<{ publish_state: string; external_url: string; published_at: string; task_id: string }>(`select * from editorial_variants where id='${variant}'`);
    expect(v.publish_state).toBe("published");
    expect(v.external_url).toBe("https://instagram.com/p/abc");
    expect(v.published_at).toBeTruthy();
    const t = await one<{ state: string; lease_owner: string | null }>(`select * from tasks where id='${v.task_id}'`);
    expect(t).toMatchObject({ state: "completed", lease_owner: null });
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select unschedule_content_item('${draft}')`)).resolves.toBeTruthy();
    });
    expect((await one<{ publish_state: string }>(`select publish_state from editorial_variants where id='${variant}'`)).publish_state).toBe("published");
  });

  it("unschedules and cancels queued tasks", async () => {
    const d2 = "d0000000-0000-4000-8000-00000000000b";
    const v2 = "e0000000-0000-4000-8000-00000000000b";
    await asUser(db, ids.ownerA, async () => {
      await db.exec(`insert into editorial_drafts(id,workspace_id,name,body) values ('${d2}','${ids.wsA}','Solo','x')`);
      await db.exec(`insert into editorial_variants(id,workspace_id,draft_id,channel_id,body) values ('${v2}','${ids.wsA}','${d2}','${chA}','x')`);
      // Owners may schedule unapproved content without a campaign requiring approval.
      await db.query(`select schedule_content_item('${d2}','${future()}','[{"variantId":"${v2}","mode":"api"}]'::jsonb)`);
    });
    const { task_id } = await one<{ task_id: string }>(`select task_id from editorial_variants where id='${v2}'`);
    await asUser(db, ids.memberA, () => db.query(`select unschedule_content_item('${d2}')`));
    expect((await one<{ publish_state: string }>(`select publish_state from editorial_variants where id='${v2}'`)).publish_state).toBe("draft");
    expect((await one<{ state: string }>(`select state from tasks where id='${task_id}'`)).state).toBe("cancelled");
    await expect(db.exec(`update editorial_variants set publish_state='published' where id='${v2}'`)).rejects.toThrow(/illegal publish transition/);
  });

  it("rejects assets from other workspaces", async () => {
    await db.exec(`insert into artifacts(id,workspace_id,kind,object_key,content_type,size_bytes,sha256,status)
      values ('ab000000-0000-4000-8000-00000000000b','${ids.wsB}','image','ws/${ids.wsB}/image/x','image/png',1,'${"a".repeat(64)}','available')`);
    await asUser(db, ids.memberA, async () => {
      await expect(
        db.exec(`insert into editorial_drafts(workspace_id,name,asset_ids) values ('${ids.wsA}','x','{ab000000-0000-4000-8000-00000000000b}')`),
      ).rejects.toThrow(/available artifacts of this workspace/);
    });
  });
});

describe("legacy campaign backfill", () => {
  it("is exercised by the migration (no legacy labels in a fresh database)", async () => {
    expect((await one<{ n: number }>(`select count(*)::int as n from campaigns where notes like 'Created from the legacy%'`)).n).toBe(0);
  });
});
