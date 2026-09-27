import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";


let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
}, 60000);
afterAll(async () => db?.close());

describe("00039 channels.platform", () => {
  it("allows newer platforms only as manual channels with a well-formed ref", async () => {
    // Clients still cannot write channel projections (00030); the API uses the service role.
    await asUser(db, ids.ownerA, async () => {
      await expect(db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','linkedin','manual:linkedin:x')`)).rejects.toThrow(/permission denied/);
    });
    {
      await db.exec(`insert into channels(workspace_id,platform,late_account_id,username) values ('${ids.wsA}','linkedin','manual:linkedin:brand','brand')`);
      await expect(db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','tiktok','gw-123')`)).rejects.toThrow(/channels_manual_only_platforms/);
      await expect(db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','youtube','manual:tiktok:brand')`)).rejects.toThrow(/channels_manual_ref_format/);
      await expect(db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','threads','manual:threads:Bad Handle')`)).rejects.toThrow(/channels_manual_ref_format/);
      await expect(db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','myspace','x')`)).rejects.toThrow(/channels_platform_check/);
      await expect(db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','linkedin','manual:linkedin:brand')`)).rejects.toThrow(/duplicate key/);
      // Existing Gateway platforms are unchanged.
      await db.exec(`insert into channels(workspace_id,platform,late_account_id) values ('${ids.wsA}','facebook','gw-fb-1')`);
    }
  });
});

describe("00039 secret audit + indexes", () => {
  it("accepts the rewrap audit action and creates the keyset indexes", async () => {
    await db.exec(`insert into secret_access_events(workspace_id,action,actor_type,purpose) values ('${ids.wsA}','rewrap','service','kek_rotation')`);
    await expect(db.exec(`insert into secret_access_events(workspace_id,action,actor_type) values ('${ids.wsA}','bogus','service')`)).rejects.toThrow(/action_check/);
    const { rows } = await db.query<{ indexname: string }>(`select indexname from pg_indexes where indexname in ('product_activity_ws_created_id_idx','secret_access_events_ws_created_id_idx') order by 1`);
    expect(rows.map((r) => r.indexname)).toEqual(["product_activity_ws_created_id_idx", "secret_access_events_ws_created_id_idx"]);
  });
});

describe("00039 recurring content copies", () => {
  it("links copies to their source within the workspace and allows one copy per occurrence task", async () => {
    const src = "d0000000-0000-4000-8000-0000000000e1";
    const task = "a0000000-0000-4000-8000-0000000000e1";
    await db.exec(`insert into editorial_drafts(id,workspace_id,name) values ('${src}','${ids.wsA}','Weekly tip')`);
    await db.exec(`insert into editorial_drafts(workspace_id,name,source_draft_id,source_task_id) values ('${ids.wsA}','Weekly tip · 2026-09-28','${src}','${task}')`);
    await expect(db.exec(`insert into editorial_drafts(workspace_id,name,source_draft_id,source_task_id) values ('${ids.wsA}','dup','${src}','${task}')`)).rejects.toThrow(/source_task_key/);
    await expect(db.exec(`insert into editorial_drafts(workspace_id,name,source_draft_id) values ('${ids.wsB}','cross','${src}')`)).rejects.toThrow(/editorial_drafts_source_fk/);
    await db.exec(`delete from editorial_drafts where id='${src}'`);
    const { rows } = await db.query<{ source_draft_id: string | null }>(`select source_draft_id from editorial_drafts where source_task_id='${task}'`);
    expect(rows).toEqual([{ source_draft_id: null }]);
  });
});
