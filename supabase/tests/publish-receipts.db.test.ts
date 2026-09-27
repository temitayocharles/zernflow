import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
const ch = "c0000000-0000-4000-8000-0000000000c1";
const draft = "d0000000-0000-4000-8000-0000000000c1";
const vApi = "e0000000-0000-4000-8000-0000000000c1";
const vManual = "e0000000-0000-4000-8000-0000000000c2";
const chManual = "c0000000-0000-4000-8000-0000000000c2";
const future = () => new Date(Date.now() + 3600_000).toISOString();

async function one<T>(sql: string): Promise<T> {
  const { rows } = await db.query<T>(sql);
  return rows[0];
}

async function variantKey(id: string) {
  return one<{ idempotency_key: string; task_id: string; publish_state: string }>(`select idempotency_key, task_id, publish_state from editorial_variants where id='${id}'`);
}

/** Simulates the engine (service role): claim the task and move it to waiting_for_user after an unknown outcome. */
async function strandAsUnknown(id: string, status: "unknown" | "partial") {
  const v = await variantKey(id);
  await db.exec(`
    update tasks set state='running', attempts=attempts+1, lease_owner='w', lease_expires_at=now()+interval '5 minutes', started_at=now() where id='${v.task_id}';
    update editorial_variants set publish_state='publishing', attempt_count=attempt_count+1 where id='${id}';
    insert into publish_receipts(workspace_id,variant_id,task_id,idempotency_key,attempt,mode,provider,status)
      values ('${ids.wsA}','${id}','${v.task_id}','${v.idempotency_key}',1,'api','agent-social-gateway','submitting');
    update publish_receipts set status='${status}', error_class='unknown_outcome', external_ref=${status === "partial" ? "'t1'" : "null"}
      where idempotency_key='${v.idempotency_key}';
    update editorial_variants set publish_state='failed', last_error='ambiguous' where id='${id}';
    update tasks set state='waiting_for_user', human_intervention='requested', lease_owner=null, lease_expires_at=null where id='${v.task_id}';
  `);
  return v;
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  await db.exec(`
    insert into channels(id,workspace_id,platform,late_account_id) values ('${ch}','${ids.wsA}','twitter','acct-x'),('${chManual}','${ids.wsA}','facebook','acct-f');
  `);
  await asUser(db, ids.ownerA, async () => {
    await db.exec(`insert into editorial_drafts(id,workspace_id,name,body,state) values ('${draft}','${ids.wsA}','R10','Hello','approved')`);
    await db.exec(`insert into editorial_variants(id,workspace_id,draft_id,channel_id,body) values ('${vApi}','${ids.wsA}','${draft}','${ch}','Hi X'),('${vManual}','${ids.wsA}','${draft}','${chManual}','Hi FB')`);
    await db.query(`select schedule_content_item('${draft}','${future()}','[{"variantId":"${vApi}","mode":"api"},{"variantId":"${vManual}","mode":"manual"}]'::jsonb)`);
  });
}, 60000);
afterAll(async () => db?.close());

describe("publish_receipts", () => {
  it("enforces the receipt state machine, identity immutability and tenancy", async () => {
    const v = await variantKey(vApi);
    const r = await one<{ id: string }>(`
      insert into publish_receipts(workspace_id,variant_id,task_id,idempotency_key,attempt,mode,provider,status)
      values ('${ids.wsA}','${vApi}','${v.task_id}','${v.idempotency_key}',9,'api','fake','submitting') returning id`);
    await expect(db.exec(`update publish_receipts set status='accepted' where id='${r.id}'`)).rejects.toThrow(/accepted_has_ref/);
    await db.exec(`update publish_receipts set status='accepted', operation_ref='op-1' where id='${r.id}'`);
    await expect(db.exec(`update publish_receipts set operation_ref='op-2' where id='${r.id}'`)).rejects.toThrow(/immutable once set/);
    await expect(db.exec(`update publish_receipts set provider='other' where id='${r.id}'`)).rejects.toThrow(/identity is immutable/);
    await expect(db.exec(`update publish_receipts set status='submitting' where id='${r.id}'`)).rejects.toThrow(/illegal publish receipt transition/);
    const settled = await one<{ settled_at: string | null }>(`update publish_receipts set status='published', external_url='https://x.com/p/1' where id='${r.id}' returning settled_at`);
    expect(settled.settled_at).not.toBeNull();
    await expect(db.exec(`update publish_receipts set error_message='x' where id='${r.id}'`)).rejects.toThrow(/settled publish receipts are immutable/);
    await expect(db.exec(`update publish_receipts set status='failed' where id='${r.id}'`)).rejects.toThrow(/illegal/);
    await expect(db.exec(`insert into publish_receipts(workspace_id,variant_id,idempotency_key,attempt,mode,provider,status,external_url)
      values ('${ids.wsA}','${vApi}','k',1,'api','fake','published','http://insecure')`)).rejects.toThrow(/external_url_check/);
    // Variant must belong to the receipt's workspace.
    await expect(db.exec(`insert into publish_receipts(workspace_id,variant_id,idempotency_key,attempt,mode,provider,status)
      values ('${ids.wsB}','${vApi}','k',1,'api','fake','submitting')`)).rejects.toThrow(/foreign key/);
    // Unique attempt per schedule.
    await expect(db.exec(`insert into publish_receipts(workspace_id,variant_id,idempotency_key,attempt,mode,provider,status)
      values ('${ids.wsA}','${vApi}','${v.idempotency_key}',9,'api','fake','submitting')`)).rejects.toThrow(/duplicate key/);
    await db.exec(`delete from publish_receipts where id='${r.id}'`);
  });

  it("members read their workspace's receipts; nobody else reads; clients never write", async () => {
    const v = await variantKey(vApi);
    await db.exec(`insert into publish_receipts(workspace_id,variant_id,idempotency_key,attempt,mode,provider,status)
      values ('${ids.wsA}','${vApi}','${v.idempotency_key}',50,'api','fake','submitting')`);
    await asUser(db, ids.memberA, async () => {
      expect((await db.query(`select 1 from publish_receipts where attempt=50`)).rows).toHaveLength(1);
      await expect(db.exec(`insert into publish_receipts(workspace_id,variant_id,idempotency_key,attempt,mode,provider,status)
        values ('${ids.wsA}','${vApi}','x',1,'api','fake','published')`)).rejects.toThrow(/permission denied/);
      await expect(db.exec(`update publish_receipts set status='failed' where attempt=50`)).rejects.toThrow(/permission denied/);
    });
    await asUser(db, ids.ownerB, async () => {
      expect((await db.query(`select 1 from publish_receipts`)).rows).toHaveLength(0);
    });
    await db.exec(`delete from publish_receipts where attempt=50`);
  });

  it("manual confirmation records an operator receipt", async () => {
    await asUser(db, ids.memberA, () => db.query(`select confirm_manual_publication('${vManual}','https://facebook.com/p/9','9')`));
    const r = await one<{ mode: string; provider: string; status: string; attempt: number; external_url: string }>(
      `select mode, provider, status, attempt, external_url from publish_receipts where variant_id='${vManual}'`);
    expect(r).toEqual({ mode: "manual", provider: "operator", status: "published", attempt: 1, external_url: "https://facebook.com/p/9" });
  });
});

describe("resolve_publication", () => {
  it("rejects when nothing is ambiguous, for other tenants, and for bad input", async () => {
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select resolve_publication('${vApi}','published','https://x.com/p/1')`)).rejects.toThrow(/only failed api\/browser/);
      await expect(db.query(`select resolve_publication('${vApi}','maybe')`)).rejects.toThrow(/published or not_published/);
    });
  });

  it("'not_published' settles the unknown receipt and requeues the job for resubmission", async () => {
    const v = await strandAsUnknown(vApi, "unknown");
    await asUser(db, ids.ownerB, async () => {
      await expect(db.query(`select resolve_publication('${vApi}','not_published')`)).rejects.toThrow(/unavailable/);
    });
    await asUser(db, ids.memberA, async () => {
      expect((await one<{ s: string }>(`select resolve_publication('${vApi}','not_published') as s`)).s).toBe("not_published");
    });
    expect(await one(`select state, human_intervention from tasks where id='${v.task_id}'`)).toEqual({ state: "queued", human_intervention: "resolved" });
    expect((await variantKey(vApi)).publish_state).toBe("scheduled");
    expect(await one(`select status, error_message from publish_receipts where idempotency_key='${v.idempotency_key}' and attempt=1`)).toEqual({
      status: "failed", error_message: "Operator confirmed the post is not live.",
    });
  });

  it("'published' completes the task and records operator evidence; partial cannot be 'not published'", async () => {
    // Second ambiguous cycle on the same schedule → partial this time.
    const v = await variantKey(vApi);
    await db.exec(`
      update tasks set state='running', attempts=attempts+1, lease_owner='w', lease_expires_at=now()+interval '5 minutes' where id='${v.task_id}';
      update editorial_variants set publish_state='publishing' where id='${vApi}';
      insert into publish_receipts(workspace_id,variant_id,task_id,idempotency_key,attempt,mode,provider,status,external_ref,parts)
        values ('${ids.wsA}','${vApi}','${v.task_id}','${v.idempotency_key}',2,'api','agent-social-gateway','partial','t1','[{"index":0,"status":"published"}]');
      update editorial_variants set publish_state='failed', last_error='partial' where id='${vApi}';
      update tasks set state='waiting_for_user', human_intervention='requested', lease_owner=null, lease_expires_at=null where id='${v.task_id}';
    `);
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select resolve_publication('${vApi}','not_published')`)).rejects.toThrow(/partially published/);
      await expect(db.query(`select resolve_publication('${vApi}','published','http://insecure')`)).rejects.toThrow(/https/);
      expect((await one<{ s: string }>(`select resolve_publication('${vApi}','published','https://x.com/brand/status/1') as s`)).s).toBe("published");
    });
    expect(await one(`select publish_state, external_url, external_ref from editorial_variants where id='${vApi}'`)).toEqual({
      publish_state: "published", external_url: "https://x.com/brand/status/1", external_ref: "t1",
    });
    expect((await one<{ state: string }>(`select state from tasks where id='${v.task_id}'`)).state).toBe("completed");
    const receipts = (await db.query<{ attempt: number; status: string; provider: string }>(
      `select attempt, status, provider from publish_receipts where idempotency_key='${v.idempotency_key}' order by attempt`)).rows;
    expect(receipts).toEqual([
      { attempt: 1, status: "failed", provider: "agent-social-gateway" },
      { attempt: 2, status: "partial", provider: "agent-social-gateway" },
      { attempt: 3, status: "published", provider: "operator" },
    ]);
    expect((await one<{ n: number }>(`select count(*)::int as n from product_activity where action='content.reconciled_published'`)).n).toBe(1);
  });
});
