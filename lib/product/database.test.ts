import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
const db=new PGlite();
const ws='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002';
const user='20000000-0000-4000-8000-000000000001';
const company='30000000-0000-4000-8000-000000000001';
beforeAll(async()=>{
  await db.exec(`create publication supabase_realtime; create schema auth; create table auth.users(id uuid primary key); create role authenticated; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create function uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  await db.exec(readFileSync('supabase/migrations/00001_initial_schema.sql','utf8').replace('create extension if not exists "uuid-ossp";',''));
  await db.exec(readFileSync('supabase/migrations/00002_rls_policies.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/00021_crm_foundations.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/00022_work_items.sql','utf8'));
  await db.exec(`insert into auth.users values('${user}'); insert into workspaces(id,name,slug) values('${ws}','A','a'),('${other}','B','b'); insert into workspace_members(workspace_id,user_id) values('${ws}','${user}'); grant usage on schema public,auth to authenticated; grant select,insert,update,delete on all tables in schema public to authenticated; select set_config('request.jwt.claim.sub','${user}',false); set role authenticated;`);
},30000);
afterAll(async()=>{await db.close();});
describe('CRM migration PostgreSQL constraints and RLS',()=>{
  it('creates an attributed immutable audit record atomically',async()=>{
    await db.exec(`insert into companies(id,workspace_id,name) values('${company}','${ws}','Acme')`);
    const result=await db.query<{actor_id:string;entity_id:string}>(`select actor_id,entity_id from product_activity`);
    expect(result.rows).toEqual([{actor_id:user,entity_id:company}]);
  });
  it('blocks foreign workspace reads and writes',async()=>{
    expect((await db.query(`select * from companies where workspace_id='${other}'`)).rows).toEqual([]);
    await expect(db.exec(`insert into companies(workspace_id,name) values('${other}','No')`)).rejects.toThrow();
  });
  it('rejects cross-tenant relations even when foreign ids are known',async()=>{
    await db.exec(`reset role; insert into companies(id,workspace_id,name) values('30000000-0000-4000-8000-000000000002','${other}','Other'); set role authenticated;`);
    await expect(db.exec(`insert into deals(workspace_id,name,company_id) values('${ws}','Invalid','30000000-0000-4000-8000-000000000002')`)).rejects.toThrow();
  });
  it('increments versions and preserves record identity',async()=>{
    await db.exec(`update companies set name='Updated',version=99 where id='${company}'`);
    expect((await db.query<{version:number}>(`select version from companies where id='${company}'`)).rows[0].version).toBe(2);
    await expect(db.exec(`update companies set id=gen_random_uuid() where id='${company}'`)).rejects.toThrow();
  });
  it('blocks spoofed notes and audit writes',async()=>{
    await expect(db.exec(`insert into customer_notes(workspace_id,company_id,body,author_id) values('${ws}','${company}','note','20000000-0000-4000-8000-000000000002')`)).rejects.toThrow();
    await expect(db.exec(`insert into product_activity(workspace_id,entity_type,entity_id,action) values('${ws}','companies','${company}','forged')`)).rejects.toThrow();
  });
  it('requires exactly one note target',async()=>{
    await expect(db.exec(`insert into customer_notes(workspace_id,body) values('${ws}','note')`)).rejects.toThrow();
    await db.exec(`insert into customer_notes(workspace_id,company_id,body) values('${ws}','${company}','Internal note')`);
  });
  it('maintains deal close/reopen timestamps in database',async()=>{
    const {rows}=await db.query<{id:string;closed_at:string}>(`insert into deals(workspace_id,name,stage) values('${ws}','Opportunity','won') returning id,closed_at`);
    expect(rows[0].closed_at).toBeTruthy();
    await db.exec(`update deals set stage='new' where id='${rows[0].id}'`);
    expect((await db.query<{closed_at:null}>(`select closed_at from deals where id='${rows[0].id}'`)).rows[0].closed_at).toBeNull();
  });
});

describe('Work item persistence',()=>{
 it('enforces transitions and immutable SLA snapshots',async()=>{
  const {rows}=await db.query<{id:string;reference:number}>(`insert into work_items(workspace_id,name) values('${ws}','Ticket') returning id,reference`);const id=rows[0].id;
  expect(rows[0].reference).toBeTruthy();
  await expect(db.exec(`update work_items set status='closed' where id='${id}'`)).rejects.toThrow();
  await expect(db.exec(`update work_items set first_response_minutes=30 where id='${id}'`)).rejects.toThrow();
  await db.exec(`update work_items set status='resolved',first_responded_at=now() where id='${id}'`);
  const done=await db.query<{resolved_at:string;first_responded_at:string}>(`select resolved_at,first_responded_at from work_items where id='${id}'`);expect(done.rows[0].resolved_at).toBeTruthy();
  await db.exec(`update work_items set status='closed' where id='${id}';update work_items set status='open',first_responded_at=null where id='${id}'`);
  const reopened=await db.query<{resolved_at:null;first_responded_at:string}>(`select resolved_at,first_responded_at from work_items where id='${id}'`);expect(reopened.rows[0].resolved_at).toBeNull();expect(reopened.rows[0].first_responded_at).toEqual(done.rows[0].first_responded_at);
 });
 it('rejects foreign assignees, queues, escalation without reason',async()=>{
  await expect(db.exec(`insert into work_items(workspace_id,name,assignee_id) values('${ws}','Bad','20000000-0000-4000-8000-000000000002')`)).rejects.toThrow();
  await expect(db.exec(`insert into work_items(workspace_id,name,escalated) values('${ws}','Bad',true)`)).rejects.toThrow();
  await db.exec(`reset role;insert into work_queues(id,workspace_id,name) values('40000000-0000-4000-8000-000000000001','${other}','Other queue');set role authenticated;`);
  await expect(db.exec(`insert into work_items(workspace_id,name,queue_id) values('${ws}','Bad','40000000-0000-4000-8000-000000000001')`)).rejects.toThrow();
 });
 it('rejects forged ticket numbers and accepts internal notes',async()=>{
  const {rows}=await db.query<{id:string}>(`insert into work_items(workspace_id,name) values('${ws}','Note target') returning id`);
  await expect(db.exec(`update work_items set reference=999999 where id='${rows[0].id}'`)).rejects.toThrow();
  await db.exec(`insert into customer_notes(workspace_id,work_item_id,body) values('${ws}','${rows[0].id}','Ticket note')`);
 });
});
