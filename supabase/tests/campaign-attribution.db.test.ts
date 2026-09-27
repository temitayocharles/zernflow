import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asService, asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
let contactA: string;
let contactB: string;
let campaign1: string;
let campaign2: string;
let campaignB: string;
let channelA: string;

const one = async <T,>(sql: string) => (await db.query<T>(sql)).rows[0];

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  contactA = (await one<{ id: string }>(`insert into contacts(workspace_id,display_name) values ('${ids.wsA}','Ada') returning id`)).id;
  contactB = (await one<{ id: string }>(`insert into contacts(workspace_id,display_name) values ('${ids.wsB}','Bob') returning id`)).id;
  campaign1 = (await one<{ id: string }>(`insert into campaigns(workspace_id,name) values ('${ids.wsA}','Spring launch') returning id`)).id;
  campaign2 = (await one<{ id: string }>(`insert into campaigns(workspace_id,name) values ('${ids.wsA}','Summer') returning id`)).id;
  campaignB = (await one<{ id: string }>(`insert into campaigns(workspace_id,name) values ('${ids.wsB}','Other tenant') returning id`)).id;
  channelA = (await one<{ id: string }>(`insert into channels(workspace_id,platform,display_name,late_account_id) values ('${ids.wsA}','instagram','Brand','acct-1') returning id`)).id;
}, 120_000);
afterAll(async () => db?.close());

describe("campaign attribution (00036)", () => {
  it("maintains first/last touch and campaigns from touchpoints", async () => {
    await db.exec(`insert into contact_touchpoints(workspace_id,contact_id,campaign_id,source,utm,occurred_at) values
      ('${ids.wsA}','${contactA}','${campaign1}','form','{"utm_source":"newsletter"}','2026-09-01T10:00:00Z')`);
    await db.exec(`insert into contact_touchpoints(workspace_id,contact_id,campaign_id,source,occurred_at) values
      ('${ids.wsA}','${contactA}','${campaign2}','comment','2026-09-10T10:00:00Z')`);
    // a back-dated touch without a campaign moves first touch but not campaigns
    await db.exec(`insert into contact_touchpoints(workspace_id,contact_id,source,occurred_at) values
      ('${ids.wsA}','${contactA}','manual','2026-08-01T10:00:00Z')`);
    const c = await one<Record<string, unknown>>(`select first_touch_source, first_touch_at, last_touch_at, first_campaign_id, last_campaign_id from contacts where id='${contactA}'`);
    expect(c.first_touch_source).toBe("manual");
    expect(new Date(c.first_touch_at as string).toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(new Date(c.last_touch_at as string).toISOString()).toBe("2026-09-10T10:00:00.000Z");
    expect(c).toMatchObject({ first_campaign_id: campaign1, last_campaign_id: campaign2 });
  });

  it("rejects cross-tenant references and duplicate dedupe keys", async () => {
    await expect(db.exec(`insert into contact_touchpoints(workspace_id,contact_id,campaign_id,source) values ('${ids.wsA}','${contactA}','${campaignB}','form')`)).rejects.toThrow(/foreign key/);
    await expect(db.exec(`insert into contact_touchpoints(workspace_id,contact_id,source) values ('${ids.wsA}','${contactB}','form')`)).rejects.toThrow(/foreign key/);
    await db.exec(`insert into contact_touchpoints(workspace_id,contact_id,source,dedupe_key) values ('${ids.wsA}','${contactA}','comment','comment:x')`);
    await expect(db.exec(`insert into contact_touchpoints(workspace_id,contact_id,source,dedupe_key) values ('${ids.wsA}','${contactA}','comment','comment:x')`)).rejects.toThrow(/duplicate/);
  });

  it("members record manual touchpoints only as themselves and cannot forge contact attribution", async () => {
    await asUser(db, ids.memberA, async () => {
      await db.exec(`insert into contact_touchpoints(workspace_id,contact_id,campaign_id,source,created_by,note) values ('${ids.wsA}','${contactA}','${campaign1}','manual','${ids.memberA}','met at event')`);
    });
    await asUser(db, ids.memberA, async () => {
      await expect(db.exec(`insert into contact_touchpoints(workspace_id,contact_id,source,created_by) values ('${ids.wsA}','${contactA}','form','${ids.memberA}')`)).rejects.toThrow(/row-level security/);
    });
    await asUser(db, ids.memberA, async () => {
      await expect(db.exec(`insert into contact_touchpoints(workspace_id,contact_id,source,created_by) values ('${ids.wsA}','${contactA}','manual','${ids.ownerA}')`)).rejects.toThrow(/row-level security/);
    });
    await asUser(db, ids.memberA, async () => {
      await db.exec(`update contacts set first_campaign_id=null, first_touch_source='forged', display_name='Ada L' where id='${contactA}'`);
    });
    const c = await one<Record<string, unknown>>(`select display_name, first_touch_source, first_campaign_id from contacts where id='${contactA}'`);
    expect(c).toMatchObject({ display_name: "Ada L", first_touch_source: "manual", first_campaign_id: campaign1 });
    await asUser(db, ids.memberA, async () => {
      await expect(db.exec(`delete from contact_touchpoints where contact_id='${contactA}'`)).resolves.toBeDefined();
    });
    expect(Number((await one<{ n: number }>(`select count(*)::int n from contact_touchpoints where contact_id='${contactA}'`)).n)).toBeGreaterThan(0);
    await asUser(db, ids.ownerB, async () => {
      expect((await db.query(`select id from contact_touchpoints`)).rows).toHaveLength(0);
    });
  });

  it("campaign_engagement counts comments on campaign posts and attributed contacts, scoped by RLS", async () => {
    const draft = (await one<{ id: string }>(`insert into editorial_drafts(workspace_id,name,body,campaign_id) values ('${ids.wsA}','Post','Hi','${campaign1}') returning id`)).id;
    await db.exec(`insert into editorial_variants(workspace_id,draft_id,channel_id,body) values ('${ids.wsA}','${draft}','${channelA}','Hi')`);
    await asService(db, async () => {
      await db.exec(`update editorial_variants set external_ref='post-1' where draft_id='${draft}'`);
    });
    await db.exec(`insert into comment_logs(channel_id,workspace_id,post_id,platform_comment_id,author_id,comment_text) values
      ('${channelA}','${ids.wsA}','post-1','c1','u1','nice'),('${channelA}','${ids.wsA}','post-1','c2','u1','again'),('${channelA}','${ids.wsA}','post-1','c3','u2','hi'),
      ('${channelA}','${ids.wsA}','other-post','c4','u3','unrelated')`);
    const rows = await asUser(db, ids.memberA, async () => (await db.query<Record<string, unknown>>(`select * from campaign_engagement('${ids.wsA}', '2000-01-01')`)).rows);
    const r1 = rows.find((r) => r.campaign_id === campaign1)!;
    expect(r1).toMatchObject({ comments: 3, commenters: 2, first_touch_contacts: 1 });
    expect(Number(r1.contacts)).toBe(1);
    const leaked = await asUser(db, ids.ownerB, async () => (await db.query(`select * from campaign_engagement('${ids.wsA}', '2000-01-01')`)).rows);
    expect(leaked).toHaveLength(0);
  });

  it("lead intake tokens: owners read metadata only; hashes immutable; revocation is final", async () => {
    const t = (await one<{ id: string }>(`insert into lead_intake_tokens(workspace_id,name,token_hash) values ('${ids.wsA}','Website','${"b".repeat(64)}') returning id`)).id;
    await asUser(db, ids.ownerA, async () => {
      expect((await db.query(`select id, name from lead_intake_tokens`)).rows).toHaveLength(1);
    });
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query(`select token_hash from lead_intake_tokens`)).rejects.toThrow(/permission denied/);
    });
    await asUser(db, ids.memberA, async () => {
      expect((await db.query(`select id from lead_intake_tokens`)).rows).toHaveLength(0);
    });
    await expect(db.exec(`update lead_intake_tokens set token_hash='${"c".repeat(64)}' where id='${t}'`)).rejects.toThrow(/immutable/);
    await db.exec(`update lead_intake_tokens set revoked_at=now() where id='${t}'`);
    await expect(db.exec(`update lead_intake_tokens set revoked_at=null where id='${t}'`)).rejects.toThrow(/cannot be restored/);
  });
});
