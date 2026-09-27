import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";
import { generateWorkerToken, workerLeaseOwner } from "@/lib/workers/tokens";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const TASK = "30000000-0000-4000-8000-000000000001";
const state = vi.hoisted(() => ({ db: null as unknown as MemoryDb, role: "owner" }));

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: async () => state.db.client, createClient: vi.fn() }));
vi.mock("@/lib/product/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/product/api")>("@/lib/product/api");
  return { ...actual, productContext: async () => ({ workspaceId: WS, role: state.role, user: { id: OWNER }, supabase: state.db.client }) };
});

import { GET as getSession, POST as reportSession } from "./tasks/[taskId]/session/route";
import { POST as claim } from "./claim/route";
import { GET as listSessions, POST as createSession } from "@/app/api/v1/browser-sessions/route";
import { POST as importState } from "@/app/api/v1/browser-sessions/[sessionId]/state/route";
import { POST as attest } from "@/app/api/v1/browser-sessions/[sessionId]/attest/route";
import { POST as check } from "@/app/api/v1/browser-sessions/[sessionId]/check/route";
import { POST as revoke } from "@/app/api/v1/browser-sessions/[sessionId]/revoke/route";

const browserToken = generateWorkerToken();
const apiToken = generateWorkerToken();
const STATE = JSON.stringify({ cookies: [{ name: "sessionid", value: "live-cookie", domain: ".instagram.com", expires: 1893456000 }] });
const req = (body?: unknown, token = browserToken.token, method = "POST") =>
  new Request("https://app.example/x", { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const t = { params: Promise.resolve({ taskId: TASK }) };
const sp = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });

beforeEach(() => {
  vi.stubEnv("ZERNFLOW_LOCAL_KEK", randomBytes(32).toString("base64"));
  vi.stubEnv("SECRET_STORE_KEK_PROVIDER", "local");
  state.role = "owner";
  state.db = createMemorySupabase(
    {
      workspace_members: [{ workspace_id: WS, user_id: OWNER, role: "owner" }],
      worker_identities: [
        { id: "w1", workspace_id: WS, name: "browser", modes: ["browser"], max_concurrency: 1, token_hash: browserToken.hash, revoked_at: null },
        { id: "w2", workspace_id: WS, name: "api", modes: ["api"], max_concurrency: 1, token_hash: apiToken.hash, revoked_at: null },
      ],
      browser_sessions: [], secrets: [], secret_versions: [], tasks: [], product_activity: [], operator_notifications: [], secret_access_events: [],
    },
    {
      defaults: {
        browser_sessions: () => ({ status: "human_login_required", storage_state_secret_id: null, permitted_use_confirmed: false, allow_experimental: false, expires_at: null, last_verified_at: null, last_error: null, profile_key: crypto.randomUUID(), last_check_task_id: null }),
        secrets: () => ({ status: "active", current_version: 1, revoked_at: null, expires_at: null, binding: null, deleted_at: null }),
        secret_versions: () => ({ revoked_at: null, kek_version: null }),
        tasks: () => ({ state: "queued" }),
      },
      rpc: { claim_tasks: () => [] },
    },
  );
});

async function setUpSession(): Promise<string> {
  const created = await (await createSession(req({ platform: "instagram", label: "Brand" }))).json();
  const id = created.session.id as string;
  expect((await importState(req(STATE), sp(id))).status).toBe(200);
  expect((await attest(req({ confirm: true, allowExperimental: true }), sp(id))).status).toBe(200);
  expect((await check(req(), sp(id))).status).toBe(201);
  return id;
}

describe("owner browser-session API", () => {
  it("creates, imports (summary only), attests, checks and revokes", async () => {
    const id = await setUpSession();
    const list = await (await listSessions()).json();
    expect(list.sessions[0]).toMatchObject({ id, status: "unverified", permitted_use_confirmed: true });
    expect(JSON.stringify(list)).not.toContain("live-cookie");
    expect(list.platforms.map((p: { platform: string }) => p.platform)).toContain("instagram");
    expect((await revoke(req(), sp(id))).status).toBe(200);
    expect((await check(req(), sp(id))).status).toBe(409);
  });

  it("members cannot manage sessions; bad input and unknown platforms are refused", async () => {
    state.role = "member";
    expect((await createSession(req({ platform: "instagram", label: "x" }))).status).toBe(403);
    state.role = "owner";
    expect((await createSession(req({ platform: "myspace", label: "x" }))).status).toBe(400);
    expect((await importState(req(STATE), sp("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    const created = await (await createSession(req({ platform: "instagram", label: "B" }))).json();
    const bad = await importState(req(JSON.stringify({ cookies: [{ name: "sessionid", value: "x", domain: ".evil.example" }] })), sp(created.session.id));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/does not belong/);
  });
});

describe("worker session endpoint", () => {
  it("releases state only to the lease holder of a browser task", async () => {
    const sessionId = await setUpSession();
    const taskRow = state.db.tables.tasks[0];
    Object.assign(taskRow, { id: TASK, state: "running", lease_owner: workerLeaseOwner("w1") });
    const ok = await getSession(req(undefined, browserToken.token, "GET"), t);
    expect(ok.status).toBe(200);
    expect((await ok.json()).session.id).toBe(sessionId);
    expect((await getSession(req(undefined, apiToken.token, "GET"), t)).status).toBe(403);
    expect((await getSession(req(undefined, "zfw_bogus_token_value_000000000000000", "GET"), t)).status).toBe(401);
    taskRow.lease_owner = workerLeaseOwner("someone-else");
    expect((await getSession(req(undefined, browserToken.token, "GET"), t)).status).toBe(409);
    taskRow.lease_owner = workerLeaseOwner("w1");
    const report = await reportSession(req({ state: "mfa_required", reason: "code requested" }), t);
    expect(await report.json()).toEqual({ ok: true, status: "mfa_required" });
    expect(state.db.tables.operator_notifications).toHaveLength(1);
  });

  it("records executor capabilities at claim time (sanitised)", async () => {
    const r = await claim(req({ modes: ["browser"], capabilities: { adapters: ["instagram:session_check:experimental", "Robert'); drop table", 7] }, version: "0.1.0" }));
    expect(r.status).toBe(204);
    expect(state.db.tables.worker_identities[0]).toMatchObject({ capabilities: { adapters: ["instagram:session_check:experimental"] }, version: "0.1.0" });
  });
});
