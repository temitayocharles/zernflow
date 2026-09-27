import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createMigratedDatabase, ids, seedTenants } from "@/lib/test/pg-harness";

let db: PGlite;
const secretA = "80000000-0000-4000-8000-00000000000a";
const secretB = "80000000-0000-4000-8000-00000000000b";

beforeAll(async () => {
  db = await createMigratedDatabase();
  await seedTenants(db);
  await db.exec(`
    insert into secrets(id,workspace_id,name,kind) values
      ('${secretA}','${ids.wsA}','AI key','ai_provider_key'),('${secretB}','${ids.wsB}','Other','api_token');
    insert into secret_versions(workspace_id,secret_id,version,ciphertext,iv,auth_tag,wrapped_dek,kek_provider,kek_key_id)
      values ('${ids.wsA}','${secretA}',1,'Y2lwaGVy','aXZpdml2aXZpdg==','dGFndGFndGFn','d3JhcHBlZA==','local','local:k1');
  `);
}, 60000);
afterAll(async () => db?.close());

describe("secret store tables", () => {
  it("never exposes ciphertext to browser roles, even owners", async () => {
    await asUser(db, ids.ownerA, async () => {
      await expect(db.query(`select * from secret_versions`)).rejects.toThrow(/permission denied/);
      const { rows } = await db.query<{ name: string }>(`select name from secrets`);
      expect(rows.map((r) => r.name)).toEqual(["AI key"]);
      await expect(db.exec(`update secrets set status='revoked'`)).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`insert into secrets(workspace_id,name,kind) values ('${ids.wsA}','x','other')`),
      ).rejects.toThrow(/permission denied/);
    });
    const svc = await asService(db, () => db.query(`select 1 from secret_versions`));
    expect(svc.rows).toHaveLength(1);
  });

  it("binds versions to their workspace and forbids restoring deleted secrets", async () => {
    await expect(
      db.exec(`insert into secret_versions(workspace_id,secret_id,version,ciphertext,iv,auth_tag,wrapped_dek,kek_provider,kek_key_id)
        values ('${ids.wsB}','${secretA}',2,'x','aXZpdml2aXY=','dGFndGFn','d3JhcHBlZA==','local','k')`),
    ).rejects.toThrow(/foreign key/);
    await db.exec(`update secrets set status='deleted' where id='${secretB}'`);
    await expect(db.exec(`update secrets set status='active' where id='${secretB}'`)).rejects.toThrow(/cannot be restored/);
  });

  it("keeps names unique among live secrets per workspace", async () => {
    await expect(db.exec(`insert into secrets(workspace_id,name,kind) values ('${ids.wsA}','ai KEY','other')`)).rejects.toThrow(/duplicate/);
    await db.exec(`insert into secrets(workspace_id,name,kind) values ('${ids.wsB}','Other','other')`); // prior one deleted
  });
});

describe("artifacts", () => {
  it("requires workspace-prefixed object keys and immutable identity", async () => {
    await expect(
      db.exec(`insert into artifacts(workspace_id,kind,object_key,content_type,size_bytes,sha256)
        values ('${ids.wsA}','image','ws/${ids.wsB}/image/x','image/png',1,'${"a".repeat(64)}')`),
    ).rejects.toThrow(/check constraint/);
    const { rows } = await db.query<{ id: string }>(`insert into artifacts(workspace_id,kind,object_key,content_type,size_bytes,sha256)
        values ('${ids.wsA}','image','ws/${ids.wsA}/image/2026/09/1','image/png',1,'${"a".repeat(64)}') returning id`);
    await expect(db.exec(`update artifacts set object_key='ws/${ids.wsA}/x' where id='${rows[0].id}'`)).rejects.toThrow(/immutable/);
    await asUser(db, ids.ownerB, async () => {
      expect((await db.query(`select 1 from artifacts`)).rows).toHaveLength(0);
    });
  });
});

describe("browser sessions", () => {
  it("cannot reference another workspace's secret and cannot be reactivated after revocation", async () => {
    await expect(
      db.exec(`insert into browser_sessions(workspace_id,platform,label,storage_state_secret_id) values ('${ids.wsB}','facebook_profile','x','${secretA}')`),
    ).rejects.toThrow(/foreign key/);
    const { rows } = await db.query<{ id: string }>(
      `insert into browser_sessions(workspace_id,platform,label) values ('${ids.wsA}','facebook_profile','Brand page') returning id`,
    );
    await db.exec(`update browser_sessions set status='revoked' where id='${rows[0].id}'`);
    await expect(db.exec(`update browser_sessions set status='healthy' where id='${rows[0].id}'`)).rejects.toThrow(/cannot be reactivated/);
    await asUser(db, ids.memberA, async () => {
      await expect(db.exec(`update browser_sessions set status='healthy'`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe("operator notifications", () => {
  it("accept platform entity types", async () => {
    await db.exec(`insert into operator_notifications(workspace_id,recipient_id,title,kind,entity_type,entity_id,dedupe_key)
      values ('${ids.wsA}','${ids.ownerA}','Secret expires soon','secret_expiring','secrets','${secretA}','k1')`);
    await expect(
      db.exec(`insert into operator_notifications(workspace_id,recipient_id,title,kind,entity_type,entity_id,dedupe_key)
        values ('${ids.wsA}','${ids.ownerA}','x','x','nope','${secretA}','k2')`),
    ).rejects.toThrow(/check constraint/);
  });
});
