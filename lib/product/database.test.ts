import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
const db = new PGlite();
const ws = "10000000-0000-4000-8000-000000000001",
  other = "10000000-0000-4000-8000-000000000002";
const user = "20000000-0000-4000-8000-000000000001";
const company = "30000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  await db.exec(
    `create publication supabase_realtime; create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb); create role authenticated; create role service_role; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create function uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;`,
  );
  await db.exec(
    readFileSync(
      "supabase/migrations/00001_initial_schema.sql",
      "utf8",
    ).replace('create extension if not exists "uuid-ossp";', ""),
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => /^\d{5}_.*\.sql$/.test(f) && !f.startsWith("00001"))
    .sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.exec(
    `insert into auth.users values('${user}'); insert into workspaces(id,name,slug) values('${ws}','A','a'),('${other}','B','b'); insert into workspace_members(workspace_id,user_id) values('${ws}','${user}'); grant usage on schema public,auth to authenticated; grant select,insert,update,delete on all tables in schema public to authenticated; select set_config('request.jwt.claim.sub','${user}',false); set role authenticated;`,
  );
}, 30000);
afterAll(async () => {
  await db.close();
});
describe("CRM migration PostgreSQL constraints and RLS", () => {
  it("creates an attributed immutable audit record atomically", async () => {
    await db.exec(
      `insert into companies(id,workspace_id,name) values('${company}','${ws}','Acme')`,
    );
    const result = await db.query<{ actor_id: string; entity_id: string }>(
      `select actor_id,entity_id from product_activity`,
    );
    expect(result.rows).toEqual([{ actor_id: user, entity_id: company }]);
  });
  it("blocks foreign workspace reads and writes", async () => {
    expect(
      (await db.query(`select * from companies where workspace_id='${other}'`))
        .rows,
    ).toEqual([]);
    await expect(
      db.exec(
        `insert into companies(workspace_id,name) values('${other}','No')`,
      ),
    ).rejects.toThrow();
  });
  it("rejects cross-tenant relations even when foreign ids are known", async () => {
    await db.exec(
      `reset role; insert into companies(id,workspace_id,name) values('30000000-0000-4000-8000-000000000002','${other}','Other'); set role authenticated;`,
    );
    await expect(
      db.exec(
        `insert into deals(workspace_id,name,company_id) values('${ws}','Invalid','30000000-0000-4000-8000-000000000002')`,
      ),
    ).rejects.toThrow();
  });
  it("increments versions and preserves record identity", async () => {
    await db.exec(
      `update companies set name='Updated',version=99 where id='${company}'`,
    );
    expect(
      (
        await db.query<{ version: number }>(
          `select version from companies where id='${company}'`,
        )
      ).rows[0].version,
    ).toBe(2);
    await expect(
      db.exec(
        `update companies set id=gen_random_uuid() where id='${company}'`,
      ),
    ).rejects.toThrow();
  });
  it("blocks spoofed notes and audit writes", async () => {
    await expect(
      db.exec(
        `insert into customer_notes(workspace_id,company_id,body,author_id) values('${ws}','${company}','note','20000000-0000-4000-8000-000000000002')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `insert into product_activity(workspace_id,entity_type,entity_id,action) values('${ws}','companies','${company}','forged')`,
      ),
    ).rejects.toThrow();
  });
  it("requires exactly one note target", async () => {
    await expect(
      db.exec(
        `insert into customer_notes(workspace_id,body) values('${ws}','note')`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `insert into customer_notes(workspace_id,company_id,body) values('${ws}','${company}','Internal note')`,
    );
  });
  it("maintains deal close/reopen timestamps in database", async () => {
    const { rows } = await db.query<{ id: string; closed_at: string }>(
      `insert into deals(workspace_id,name,stage) values('${ws}','Opportunity','won') returning id,closed_at`,
    );
    expect(rows[0].closed_at).toBeTruthy();
    await db.exec(`update deals set stage='new' where id='${rows[0].id}'`);
    expect(
      (
        await db.query<{ closed_at: null }>(
          `select closed_at from deals where id='${rows[0].id}'`,
        )
      ).rows[0].closed_at,
    ).toBeNull();
  });
});

describe("Work item persistence", () => {
  it("enforces transitions and immutable SLA snapshots", async () => {
    const { rows } = await db.query<{ id: string; reference: number }>(
      `insert into work_items(workspace_id,name) values('${ws}','Ticket') returning id,reference`,
    );
    const id = rows[0].id;
    expect(rows[0].reference).toBeTruthy();
    await expect(
      db.exec(`update work_items set status='closed' where id='${id}'`),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `update work_items set first_response_minutes=30 where id='${id}'`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `update work_items set status='resolved',first_responded_at=now() where id='${id}'`,
    );
    const done = await db.query<{
      resolved_at: string;
      first_responded_at: string;
    }>(
      `select resolved_at,first_responded_at from work_items where id='${id}'`,
    );
    expect(done.rows[0].resolved_at).toBeTruthy();
    await db.exec(
      `update work_items set status='closed' where id='${id}';update work_items set status='open',first_responded_at=null where id='${id}'`,
    );
    const reopened = await db.query<{
      resolved_at: null;
      first_responded_at: string;
    }>(
      `select resolved_at,first_responded_at from work_items where id='${id}'`,
    );
    expect(reopened.rows[0].resolved_at).toBeNull();
    expect(reopened.rows[0].first_responded_at).toEqual(
      done.rows[0].first_responded_at,
    );
  });
  it("rejects foreign assignees, queues, escalation without reason", async () => {
    await expect(
      db.exec(
        `insert into work_items(workspace_id,name,assignee_id) values('${ws}','Bad','20000000-0000-4000-8000-000000000002')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `insert into work_items(workspace_id,name,escalated) values('${ws}','Bad',true)`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `reset role;insert into work_queues(id,workspace_id,name) values('40000000-0000-4000-8000-000000000001','${other}','Other queue');set role authenticated;`,
    );
    await expect(
      db.exec(
        `insert into work_items(workspace_id,name,queue_id) values('${ws}','Bad','40000000-0000-4000-8000-000000000001')`,
      ),
    ).rejects.toThrow();
  });
  it("rejects forged ticket numbers and accepts internal notes", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into work_items(workspace_id,name) values('${ws}','Note target') returning id`,
    );
    await expect(
      db.exec(
        `update work_items set reference=999999 where id='${rows[0].id}'`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `insert into customer_notes(workspace_id,work_item_id,body) values('${ws}','${rows[0].id}','Ticket note')`,
    );
  });
});

describe("Operator notifications and mentions", () => {
  it("deduplicates mentions and rejects nonmembers", async () => {
    await db.exec(
      `insert into customer_notes(workspace_id,company_id,body,mention_ids) values('${ws}','${company}','Mention',array['${user}','${user}']::uuid[])`,
    );
    expect(
      (
        await db.query(
          `select * from operator_notifications where kind='mention'`,
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      db.exec(
        `insert into customer_notes(workspace_id,company_id,body,mention_ids) values('${ws}','${company}','No',array['20000000-0000-4000-8000-000000000099']::uuid[])`,
      ),
    ).rejects.toThrow();
  });
  it("notifies assignment and blocks payload tampering", async () => {
    await db.exec(
      `insert into work_items(workspace_id,name,assignee_id) values('${ws}','Assigned','${user}')`,
    );
    const { rows } = await db.query<{ id: string }>(
      `select id from operator_notifications where kind='assignment'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      db.exec(
        `update operator_notifications set title='Forged' where id='${rows[0].id}'`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `update operator_notifications set read_at=now() where id='${rows[0].id}'`,
    );
    await expect(
      db.exec(
        `insert into operator_notifications(workspace_id,recipient_id,title,kind,entity_type,entity_id,dedupe_key) values('${ws}','${user}','Fake','mention','companies','${company}','fake')`,
      ),
    ).rejects.toThrow();
  });
});

describe("Editorial and external source configuration", () => {
  it("invalidates editorial approval on content changes", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into editorial_drafts(workspace_id,name,body) values('${ws}','Editorial','Content') returning id`,
    );
    const id = rows[0].id;
    await expect(
      db.exec(`update editorial_drafts set state='approved' where id='${id}'`),
    ).rejects.toThrow();
    await db.exec(
      `update editorial_drafts set state='in_review' where id='${id}';update editorial_drafts set state='approved' where id='${id}'`,
    );
    expect(
      (
        await db.query<{ reviewed_by: string }>(
          `select reviewed_by from editorial_drafts where id='${id}'`,
        )
      ).rows[0].reviewed_by,
    ).toBe(user);
    await db.exec(
      `update editorial_drafts set body='Revised' where id='${id}'`,
    );
    expect(
      (
        await db.query<{ state: string }>(
          `select state from editorial_drafts where id='${id}'`,
        )
      ).rows[0].state,
    ).toBe("draft");
    await expect(
      db.exec(`update editorial_drafts set state='published' where id='${id}'`),
    ).rejects.toThrow();
  });
  it("limits knowledge and mailbox configuration to owners", async () => {
    await db.exec(
      `reset role;update workspace_members set role='member' where workspace_id='${ws}' and user_id='${user}';set role authenticated;`,
    );
    await expect(
      db.exec(
        `insert into knowledge_sources(workspace_id,name,source_ref) values('${ws}','Knowledge','source')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `insert into mailbox_identities(workspace_id,name,address) values('${ws}','Support','support@example.com')`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `reset role;update workspace_members set role='owner' where workspace_id='${ws}' and user_id='${user}';set role authenticated;`,
    );
    await db.exec(
      `insert into knowledge_sources(workspace_id,name,source_ref) values('${ws}','Knowledge','source');insert into mailbox_identities(workspace_id,name,address) values('${ws}','Support','support@example.com')`,
    );
  });
});

describe("Operator aggregate security", () => {
  it("aggregates without sampling and refuses foreign workspaces", async () => {
    const result = await db.query<{
      metrics: { work_items: { total: number }; companies: number };
    }>(`select operator_metrics('${ws}') as metrics`);
    expect(result.rows[0].metrics.work_items.total).toBeGreaterThan(0);
    expect(result.rows[0].metrics.companies).toBe(1);
    await expect(
      db.exec(`select operator_metrics('${other}')`),
    ).rejects.toThrow();
  });
});

describe("Directory and record integrity", () => {
  it("scopes the directory and exposes no email", async () => {
    const result = await db.query(
      `select * from workspace_operator_directory('${ws}')`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).not.toHaveProperty("email");
    await expect(
      db.exec(`select * from workspace_operator_directory('${other}')`),
    ).rejects.toThrow();
  });
  it("prevents customer profile identity relinking", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into contacts(workspace_id,display_name) values('${ws}','First'),('${ws}','Second') returning id`,
    );
    const profile = await db.query<{ id: string }>(
      `insert into customer_profiles(workspace_id,contact_id) values('${ws}','${rows[0].id}') returning id`,
    );
    await expect(
      db.exec(
        `update customer_profiles set contact_id='${rows[1].id}' where id='${profile.rows[0].id}'`,
      ),
    ).rejects.toThrow();
  });
  it("hides notifications from another workspace member", async () => {
    const stranger = "20000000-0000-4000-8000-000000000002";
    await db.exec(
      `reset role;insert into auth.users(id) values('${stranger}');insert into workspace_members(workspace_id,user_id) values('${ws}','${stranger}');select set_config('request.jwt.claim.sub','${stranger}',false);set role authenticated;`,
    );
    expect(
      (await db.query("select * from operator_notifications")).rows,
    ).toEqual([]);
    await db.exec(`select set_config('request.jwt.claim.sub','${user}',false)`);
  });
});

describe("Atomic bulk work changes", () => {
  it("rolls back all selected changes when one version is stale", async () => {
    const { rows } = await db.query<{ id: string; version: number }>(
      `insert into work_items(workspace_id,name) values('${ws}','Bulk A'),('${ws}','Bulk B') returning id,version`,
    );
    const changes = rows.map((r, index) => ({
      ...r,
      version: index === 0 ? r.version : 999,
      status: "resolved",
    }));
    await expect(
      db.query(`select bulk_update_work_items($1,$2::jsonb)`, [
        ws,
        JSON.stringify(changes),
      ]),
    ).rejects.toThrow();
    const current = await db.query<{ status: string }>(
      `select status from work_items where id=any($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    expect(current.rows.every((r) => r.status === "open")).toBe(true);
    const valid = rows.map((r) => ({ ...r, status: "resolved" }));
    expect(
      (
        await db.query<{ updated: number }>(
          `select bulk_update_work_items($1,$2::jsonb) as updated`,
          [ws, JSON.stringify(valid)],
        )
      ).rows[0].updated,
    ).toBe(2);
  });
  it("rejects foreign workspace bulk execution", async () => {
    await expect(
      db.query(`select bulk_update_work_items($1,$2::jsonb)`, [
        other,
        JSON.stringify([{ id: company, version: 1, status: "open" }]),
      ]),
    ).rejects.toThrow();
  });
});
