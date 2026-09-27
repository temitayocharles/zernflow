import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;

async function enqueue(key: string, extra = "", workspace = ids.wsA): Promise<string> {
  const cols = extra ? `, ${extra.split("=")[0]}` : "";
  const vals = extra ? `, ${extra.split("=").slice(1).join("=")}` : "";
  const { rows } = await asService(db, () =>
    db.query<{ id: string }>(
      `insert into tasks(workspace_id,kind,objective,idempotency_key${cols})
       values ('${workspace}','system.noop','Test ${key}','${key}'${vals}) returning id`,
    ),
  );
  return rows[0].id;
}
async function state(id: string) {
  const { rows } = await db.query<{ state: string; attempts: number; dead: boolean; lease_owner: string | null }>(
    `select state, attempts, dead_lettered_at is not null as dead, lease_owner from tasks where id='${id}'`,
  );
  return rows[0];
}
async function claim(worker = "w1", modes = "{internal}", limit = 10, maxRunning: number | null = null) {
  const { rows } = await asService(db, () =>
    db.query<{ id: string }>(
      `select id from claim_tasks('${worker}','${modes}'::text[],${limit},60,null,${maxRunning ?? "null"})`,
    ),
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
}, 60000);
afterAll(async () => db?.close());

describe("task lifecycle", () => {
  it("claims with a lease, completes once, and ignores lost leases", async () => {
    const id = await enqueue("life-1");
    expect(await claim()).toEqual([id]);
    expect(await state(id)).toMatchObject({ state: "running", attempts: 1, lease_owner: "w1" });
    expect(await claim("w2")).toEqual([]); // no double claim
    const other = await asService(db, () => db.query<{ ok: boolean }>(`select complete_task('${id}','w2','{}') ok`));
    expect(other.rows[0].ok).toBe(false);
    const done = await asService(db, () => db.query<{ ok: boolean }>(`select complete_task('${id}','w1','{"x":1}') ok`));
    expect(done.rows[0].ok).toBe(true);
    expect(await state(id)).toMatchObject({ state: "completed", lease_owner: null });
  });

  it("is idempotent per workspace key", async () => {
    await enqueue("dup-1");
    await expect(enqueue("dup-1")).rejects.toThrow(/duplicate key/);
    await expect(enqueue("dup-1", "", ids.wsB)).resolves.toBeTruthy();
  });

  it("retries with attempt accounting and dead-letters when exhausted", async () => {
    const id = await enqueue("retry-1", `retry_policy='{"maxAttempts":2}'`);
    await claim();
    const first = await asService(db, () =>
      db.query<{ s: string }>(`select fail_task('${id}','w1','{"class":"transient","message":"x"}','retry',now()) s`),
    );
    expect(first.rows[0].s).toBe("retrying");
    expect(await claim()).toEqual([id]);
    const second = await asService(db, () =>
      db.query<{ s: string }>(`select fail_task('${id}','w1','{"class":"transient","message":"x"}','retry',now()) s`),
    );
    expect(second.rows[0].s).toBe("failed");
    expect(await state(id)).toMatchObject({ state: "failed", attempts: 2, dead: true });
  });

  it("moves human-required errors to waiting_for_user and defers without consuming attempts", async () => {
    const a = await enqueue("human-1");
    await claim();
    await asService(db, () =>
      db.query(`select fail_task('${a}','w1','{"class":"human_challenge","message":"MFA prompt"}','needs_user')`),
    );
    const { rows } = await db.query<{ state: string; human_intervention: string; intervention_reason: string }>(
      `select state, human_intervention, intervention_reason from tasks where id='${a}'`,
    );
    expect(rows[0]).toEqual({ state: "waiting_for_user", human_intervention: "requested", intervention_reason: "MFA prompt" });

    const b = await enqueue("defer-1");
    await claim();
    await asService(db, () => db.query(`select defer_task('${b}','w1',now()-interval '1 second','awaiting provider')`));
    expect(await state(b)).toMatchObject({ state: "waiting", attempts: 0 });
    expect(await claim()).toEqual([b]); // due again
  });

  it("recovers expired leases after a worker crash", async () => {
    const id = await enqueue("crash-1");
    await claim("dead-worker");
    await db.exec(`update tasks set lease_expires_at = now() - interval '1 minute' where id='${id}'`);
    const n = await asService(db, () => db.query<{ n: number }>(`select recover_expired_leases() n`));
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(await state(id)).toMatchObject({ state: "retrying", lease_owner: null });
    expect(await claim("w-new")).toContain(id);
  });

  it("respects dependencies, approval gates, modes and the per-worker concurrency cap", async () => {
    await db.exec(`update tasks set state='cancelled' where state in ('queued','retrying','waiting','running')`);
    const parent = await enqueue("dep-parent");
    const child = await enqueue("dep-child", `depends_on=array['${parent}']::uuid[]`);
    const gated = await enqueue("gated", `requires_approval,approval_state=true,'pending'`);
    const browser = await enqueue("browser-1", `execution_mode='browser'`);
    expect(await claim()).toEqual([parent]);
    await asService(db, () => db.query(`select complete_task('${parent}','w1')`));
    expect(await claim()).toEqual([child]);
    expect(await claim("b1", "{browser}", 5, 1)).toEqual([browser]);
    const b2 = await enqueue("browser-2", `execution_mode='browser'`);
    expect(await claim("b1", "{browser}", 5, 1)).toEqual([]); // cap reached
    await asService(db, () => db.query(`select complete_task('${browser}','b1')`));
    expect(await claim("b1", "{browser}", 5, 1)).toEqual([b2]);
    expect((await state(gated)).state).toBe("queued");
  });

  it("rejects cross-workspace dependencies and illegal transitions", async () => {
    const foreign = await enqueue("foreign-dep", "", ids.wsB);
    await expect(enqueue("bad-dep", `depends_on=array['${foreign}']::uuid[]`)).rejects.toThrow(/same workspace/);
    const done = await enqueue("illegal-1");
    await claim();
    await asService(db, () => db.query(`select complete_task('${done}','w1')`));
    await expect(db.exec(`update tasks set state='queued' where id='${done}'`)).rejects.toThrow(/illegal task transition/);
    await expect(db.exec(`update tasks set input='{"x":1}' where id='${done}'`)).rejects.toThrow(/immutable/);
  });
});

describe("operator RPCs and tenant isolation", () => {
  it("lets members read only their workspace and never write directly", async () => {
    await enqueue("iso-b", "", ids.wsB);
    await asUser(db, ids.memberA, async () => {
      const { rows } = await db.query<{ workspace_id: string }>(`select distinct workspace_id from tasks`);
      expect(rows.map((r) => r.workspace_id)).toEqual([ids.wsA]);
      await expect(
        db.exec(`insert into tasks(workspace_id,kind,objective,idempotency_key) values ('${ids.wsA}','x','y','z')`),
      ).rejects.toThrow(/permission denied/);
      await expect(db.exec(`update tasks set priority=1`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select claim_tasks('evil','{internal}',10,60)`)).rejects.toThrow(/permission denied/);
    });
  });

  it("gates approval to owners and cancels on rejection", async () => {
    const gated = await enqueue("approve-1", `requires_approval,approval_state=true,'pending'`);
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select approve_task('${gated}', true)`)).rejects.toThrow(/unavailable/);
    });
    await asUser(db, ids.ownerB, async () => {
      await expect(db.query(`select approve_task('${gated}', true)`)).rejects.toThrow(/unavailable/);
    });
    await asUser(db, ids.ownerA, () => db.query(`select approve_task('${gated}', true, 'looks good')`));
    const { rows } = await db.query<{ approval_state: string; approved_by: string }>(
      `select approval_state, approved_by from tasks where id='${gated}'`,
    );
    expect(rows[0]).toEqual({ approval_state: "approved", approved_by: ids.ownerA });
    const audit = await db.query(`select 1 from product_activity where entity_id='${gated}' and action='task.approved'`);
    expect(audit.rows).toHaveLength(1);

    const rejected = await enqueue("approve-2", `requires_approval,approval_state=true,'pending'`);
    await asUser(db, ids.ownerA, () => db.query(`select approve_task('${rejected}', false)`));
    expect((await state(rejected)).state).toBe("cancelled");
  });

  it("retries dead letters only as owner; members may resume interventions and cancel", async () => {
    await db.exec(`update tasks set state='cancelled' where state in ('queued','retrying','waiting','running')`);
    const dead = await enqueue("dead-1", `retry_policy='{"maxAttempts":1}'`);
    await claim();
    await asService(db, () => db.query(`select fail_task('${dead}','w1','{"class":"internal","message":"boom"}','retry')`));
    await asUser(db, ids.memberA, async () => {
      await expect(db.query(`select retry_task('${dead}')`)).rejects.toThrow(/owner access required/);
    });
    await asUser(db, ids.ownerA, () => db.query(`select retry_task('${dead}')`));
    expect(await state(dead)).toMatchObject({ state: "queued", attempts: 0, dead: false });

    const human = await enqueue("human-2");
    await claim();
    await asService(db, () => db.query(`select fail_task('${human}','w1','{"class":"reauth_required","message":"login"}','needs_user')`));
    await asUser(db, ids.memberA, () => db.query(`select retry_task('${human}')`));
    expect((await state(human)).state).toBe("queued");
    await asUser(db, ids.memberA, () => db.query(`select cancel_task('${human}','no longer needed')`));
    expect((await state(human)).state).toBe("cancelled");
    await asUser(db, ids.ownerB, async () => {
      await expect(db.query(`select cancel_task('${dead}')`)).rejects.toThrow(/unavailable/);
    });
  });
});

describe("schedules", () => {
  it("materializes exactly once per expected run under concurrent ticks", async () => {
    const { rows } = await db.query<{ id: string; next_run_at: string }>(
      `insert into task_schedules(workspace_id,name,kind,interval_seconds,next_run_at)
       values ('${ids.wsA}','Nightly','system.noop',3600, date_trunc('minute', now()) - interval '1 minute')
       returning id, next_run_at::text`,
    );
    const s = rows[0];
    const run = () =>
      asService(db, () =>
        db.query<{ t: string | null }>(
          `select materialize_schedule('${s.id}', '${s.next_run_at}'::timestamptz, '${s.next_run_at}'::timestamptz + interval '1 hour') t`,
        ),
      );
    const first = await run();
    const second = await run();
    expect(first.rows[0].t).toBeTruthy();
    expect(second.rows[0].t).toBeNull();
    const tasks = await db.query(`select 1 from tasks where schedule_id='${s.id}'`);
    expect(tasks.rows).toHaveLength(1);
  });

  it("hides worker token hashes from every browser role", async () => {
    await db.exec(`insert into worker_identities(workspace_id,name,token_hash,token_prefix) values
      ('${ids.wsA}','browser','${"a".repeat(64)}','zfw_abcd')`);
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query(`select token_hash from worker_identities`)).rejects.toThrow(/permission denied/);
      expect((await db.query(`select name from worker_identities`)).rows).toHaveLength(1);
    });
    await asUser(db, ids.memberA, async () => {
      expect((await db.query(`select name from worker_identities`)).rows).toHaveLength(0);
    });
  });
});
