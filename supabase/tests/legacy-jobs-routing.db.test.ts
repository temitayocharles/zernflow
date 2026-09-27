import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
const chA = "41000000-0000-4000-8000-00000000000a";
const chB = "41000000-0000-4000-8000-00000000000b";
const contactA = "51000000-0000-4000-8000-00000000000a";
const contactA2 = "51000000-0000-4000-8000-0000000000a2";
const flowA = "61000000-0000-4000-8000-00000000000a";
const flowB = "61000000-0000-4000-8000-00000000000b";
const sessionA = "62000000-0000-4000-8000-00000000000a";
const sessionB = "62000000-0000-4000-8000-00000000000b";
const bc1 = "71000000-0000-4000-8000-000000000001";
const bc2 = "71000000-0000-4000-8000-000000000002";
const rcpt1 = "72000000-0000-4000-8000-000000000001";
const rcpt2 = "72000000-0000-4000-8000-000000000002";

const flip = (type: string, target: "tasks" | "scheduled_jobs") =>
  db.exec(`update legacy_queue_routes set target='${target}', updated_at=now() where job_type='${type}'`);

const resumePayload = (session: string, ws: string, node = "delay-1") =>
  JSON.stringify({ sessionId: session, workspaceId: ws, nodeId: node, flowId: flowA, channelId: chA });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  await db.exec(`
    insert into channels(id,workspace_id,platform,late_account_id) values
      ('${chA}','${ids.wsA}','telegram','gw-a'),('${chB}','${ids.wsB}','telegram','gw-b');
    insert into contacts(id,workspace_id,display_name) values
      ('${contactA}','${ids.wsA}','A'),('${contactA2}','${ids.wsA}','A2');
    insert into flows(id,workspace_id,name) values ('${flowA}','${ids.wsA}','F'),('${flowB}','${ids.wsB}','G');
    insert into flow_sessions(id,contact_id,flow_id,channel_id) values
      ('${sessionA}','${contactA}','${flowA}','${chA}');
  `);
  await db.exec(`
    insert into contacts(id,workspace_id,display_name) values ('51000000-0000-4000-8000-00000000000b','${ids.wsB}','B');
    insert into flow_sessions(id,contact_id,flow_id,channel_id) values
      ('${sessionB}','51000000-0000-4000-8000-00000000000b','${flowB}','${chB}');
  `);
}, 60000);
afterAll(async () => db?.close());

describe("legacy_queue_routes switch", () => {
  it("defaults every legacy type to scheduled_jobs (no behaviour change on migrate)", async () => {
    const { rows } = await db.query<{ job_type: string; target: string }>(
      "select job_type, target from legacy_queue_routes order by job_type",
    );
    expect(rows).toEqual([
      { job_type: "process_social_gateway_event", target: "scheduled_jobs" },
      { job_type: "resume_flow", target: "scheduled_jobs" },
      { job_type: "send_broadcast", target: "scheduled_jobs" },
    ]);
  });

  it("is invisible and immutable to tenants, and its RPCs are service-only", async () => {
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query("select * from legacy_queue_routes")).rejects.toThrow(/permission denied/);
      await expect(db.exec("update legacy_queue_routes set target='tasks'")).rejects.toThrow(/permission denied/);
      await expect(db.query("select legacy_queue_target('resume_flow')")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from legacy_queue_status()")).rejects.toThrow(/permission denied/);
      await expect(
        db.query(`select schedule_flow_resume('${resumePayload(sessionA, ids.wsA)}'::jsonb, now())`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("rejects targets outside the allowed set", async () => {
    await expect(db.exec("update legacy_queue_routes set target='kafka' where job_type='resume_flow'")).rejects.toThrow(
      /check/,
    );
  });
});

describe("schedule_flow_resume", () => {
  it("writes scheduled_jobs while the route is legacy", async () => {
    const { rows } = await db.query<{ t: string }>(
      `select schedule_flow_resume('${resumePayload(sessionA, ids.wsA)}'::jsonb, now() + interval '1 hour') as t`,
    );
    expect(rows[0].t).toBe("scheduled_jobs");
    const job = await db.query<{ workspace_id: string }>(
      `select workspace_id from scheduled_jobs where type='resume_flow' and payload->>'sessionId'='${sessionA}'`,
    );
    expect(job.rows).toEqual([{ workspace_id: ids.wsA }]);
  });

  it("writes an idempotent durable task with the legacy retry budget once flipped", async () => {
    await flip("resume_flow", "tasks");
    const at = "2031-01-02T03:04:05.678Z";
    for (let i = 0; i < 2; i += 1) {
      const { rows } = await db.query<{ t: string }>(
        `select schedule_flow_resume('${resumePayload(sessionA, ids.wsA, "delay-2")}'::jsonb, '${at}') as t`,
      );
      expect(rows[0].t).toBe("tasks");
    }
    const { rows } = await db.query<{
      kind: string;
      state: string;
      max: number;
      subject_type: string;
      subject_id: string;
      mode: string;
    }>(
      `select kind, state, (retry_policy->>'maxAttempts')::int as max, subject_type, subject_id, execution_mode as mode
         from tasks where kind='flow.resume' and workspace_id='${ids.wsA}'`,
    );
    expect(rows).toEqual([
      { kind: "flow.resume", state: "queued", max: 3, subject_type: "flow_sessions", subject_id: sessionA, mode: "internal" },
    ]);
    await flip("resume_flow", "scheduled_jobs");
  });

  it("refuses a session that belongs to another workspace", async () => {
    await expect(
      db.query(`select schedule_flow_resume('${resumePayload(sessionB, ids.wsA)}'::jsonb, now())`),
    ).rejects.toThrow(/does not belong/);
    await expect(db.query(`select schedule_flow_resume('{"sessionId":"x"}'::jsonb, now())`)).rejects.toThrow(
      /requires workspaceId/,
    );
  });
});

describe("schedule_broadcast_delivery routing", () => {
  beforeAll(async () => {
    await db.exec(`
      insert into broadcasts(id,workspace_id,name,message_content) values
        ('${bc1}','${ids.wsA}','B1','{"text":"hi"}'),('${bc2}','${ids.wsA}','B2','{"text":"yo"}');
      insert into broadcast_recipients(id,broadcast_id,contact_id,channel_id) values
        ('${rcpt1}','${bc1}','${contactA}','${chA}'),('${rcpt2}','${bc2}','${contactA2}','${chA}');
    `);
  });

  it("enqueues broadcast.deliver tasks when flipped, keeping the membership check", async () => {
    await flip("send_broadcast", "tasks");
    await asUser(db, ids.ownerB, async () => {
      await expect(db.query(`select schedule_broadcast_delivery('${bc1}')`)).rejects.toThrow(/unavailable/);
    });
    const { rows } = await asUser(db, ids.memberA, () =>
      db.query<{ n: number }>(`select schedule_broadcast_delivery('${bc1}') as n`),
    );
    expect(rows[0].n).toBe(1);
    const task = await db.query<{ key: string; input: { recipientId: string } }>(
      `select idempotency_key as key, input from tasks where kind='broadcast.deliver'`,
    );
    expect(task.rows).toEqual([{ key: `broadcast:${rcpt1}`, input: { broadcastId: bc1, recipientId: rcpt1 } }]);
    const legacy = await db.query(`select 1 from scheduled_jobs where dedupe_key='broadcast:${rcpt1}'`);
    expect(legacy.rows).toHaveLength(0);
  });

  it("never enqueues a recipient in both queues", async () => {
    // A recipient already queued legacy (pre-flip) is skipped by the task path.
    await db.exec(`
      insert into scheduled_jobs(type,payload,run_at,dedupe_key)
      values ('send_broadcast', jsonb_build_object('broadcastId','${bc2}','recipientId','${rcpt2}'), now(), 'broadcast:${rcpt2}');
    `);
    const tasksMode = await asUser(db, ids.memberA, () =>
      db.query<{ n: number }>(`select schedule_broadcast_delivery('${bc2}') as n`),
    );
    expect(tasksMode.rows[0].n).toBe(0);

    // And the legacy path skips recipients that already have a task.
    await flip("send_broadcast", "scheduled_jobs");
    await db.exec(`update broadcasts set status='draft' where id='${bc1}'`);
    const legacyMode = await asUser(db, ids.memberA, () =>
      db.query<{ n: number }>(`select schedule_broadcast_delivery('${bc1}') as n`),
    );
    expect(legacyMode.rows[0].n).toBe(0);
    const counts = await db.query<{ n: number }>(
      `select count(*)::int as n from scheduled_jobs where dedupe_key='broadcast:${rcpt1}'`,
    );
    expect(counts.rows[0].n).toBe(0);
  });
});

describe("claim_social_gateway_webhook routing", () => {
  const claim = (eventId: string, delivery: string, channel = chA) =>
    db.query<{ r: string }>(
      `select claim_social_gateway_webhook('${eventId}','${delivery}','message.received','${channel}','{"k":1}'::jsonb) as r`,
    );

  it("queues a gateway.event task and requeues it after a failed attempt", async () => {
    await flip("process_social_gateway_event", "tasks");
    expect((await claim("evt-1", "d-1")).rows[0].r).toBe("queued");
    expect((await claim("evt-1", "d-2")).rows[0].r).toBe("already_queued");

    const task = await db.query<{ id: string; state: string; ws: string }>(
      `select id, state, workspace_id as ws from tasks where idempotency_key='gateway-event:evt-1'`,
    );
    expect(task.rows[0]).toMatchObject({ state: "queued", ws: ids.wsA });

    // Simulate an exhausted attempt: task dead-lettered, ledger marked failed.
    await db.exec(`
      update tasks set state='running', attempts=3, lease_owner='w', lease_expires_at=now()+interval '1 minute'
       where id='${task.rows[0].id}';
      update tasks set state='failed', lease_owner=null, lease_expires_at=null, current_step='settled'
       where id='${task.rows[0].id}';
      update webhook_events set status='failed' where event_id='evt-1';
    `);
    expect((await claim("evt-1", "d-3")).rows[0].r).toBe("requeued");
    const after = await db.query<{ state: string; attempts: number; current_step: string | null }>(
      `select state, attempts, current_step from tasks where id='${task.rows[0].id}'`,
    );
    expect(after.rows[0]).toEqual({ state: "queued", attempts: 0, current_step: null });
    const legacy = await db.query(`select 1 from scheduled_jobs where dedupe_key='evt-1'`);
    expect(legacy.rows).toHaveLength(0);
  });

  it("falls back to the legacy queue when the channel has no workspace", async () => {
    const orphan = "41000000-0000-4000-8000-0000000000ff";
    expect((await claim("evt-2", "d-10", orphan)).rows[0].r).toBe("queued");
    const legacy = await db.query(`select 1 from scheduled_jobs where dedupe_key='evt-2'`);
    expect(legacy.rows).toHaveLength(1);
    await flip("process_social_gateway_event", "scheduled_jobs");
  });

  it("keeps the legacy contract while the route is legacy", async () => {
    expect((await claim("evt-3", "d-20")).rows[0].r).toBe("queued");
    const legacy = await db.query<{ status: string }>(`select status from scheduled_jobs where dedupe_key='evt-3'`);
    expect(legacy.rows).toEqual([{ status: "pending" }]);
  });
});

describe("legacy_queue_status evidence", () => {
  it("reports pending legacy rows per type with the current target", async () => {
    const { rows } = await db.query<{ job_type: string; target: string; pending: number }>(
      "select job_type, target, pending::int as pending from legacy_queue_status()",
    );
    const byType = Object.fromEntries(rows.map((r) => [r.job_type, r]));
    expect(byType.resume_flow).toMatchObject({ target: "scheduled_jobs", pending: 1 });
    expect(byType.send_broadcast.pending).toBe(1);
    expect(byType.process_social_gateway_event.pending).toBe(2);
  });
});
