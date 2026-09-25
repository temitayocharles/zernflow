import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";
import {
  attestSession, checkBlocker, createBrowserSession, importStorageState, reportSessionState, requestSessionCheck,
  revokeBrowserSession, SessionError, sessionForLeasedTask,
} from "./service";
import { sweepBrowserSessions } from "./sweep";
import type { BrowserSessionRow, TaskRow } from "@/lib/types/platform";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const STATE = (cookies = [{ name: "sessionid", value: "live-cookie-value", domain: ".instagram.com", expires: 1893456000 }]) => JSON.stringify({ cookies, origins: [] });

let db: MemoryDb;
beforeEach(() => {
  vi.stubEnv("ZERNFLOW_LOCAL_KEK", randomBytes(32).toString("base64"));
  vi.stubEnv("SECRET_STORE_KEK_PROVIDER", "local");
  db = createMemorySupabase(
    { workspace_members: [{ workspace_id: WS, user_id: OWNER, role: "owner" }], browser_sessions: [], secrets: [], secret_versions: [], tasks: [], product_activity: [], operator_notifications: [], secret_access_events: [] },
    {
      defaults: {
        browser_sessions: () => ({ status: "human_login_required", storage_state_secret_id: null, permitted_use_confirmed: false, allow_experimental: false, expires_at: null, last_verified_at: null, last_error: null, profile_key: crypto.randomUUID(), last_check_task_id: null, capabilities: {} }),
        secrets: () => ({ status: "active", current_version: 1, revoked_at: null, expires_at: null, binding: null, deleted_at: null }),
        secret_versions: () => ({ revoked_at: null, kek_version: null }),
        tasks: () => ({ state: "queued" }),
      },
      constraints: {
        tasks: (r, rows) => (rows.some((x) => x.idempotency_key === r.idempotency_key && x.workspace_id === r.workspace_id) ? "23505" : null),
        operator_notifications: (r, rows) => (rows.some((x) => x.dedupe_key === r.dedupe_key && x.recipient_id === r.recipient_id) ? "23505" : null),
      },
    },
  );
});

async function readySession(): Promise<BrowserSessionRow> {
  const s = await createBrowserSession(db.client as never, { workspaceId: WS, userId: OWNER, platform: "instagram", label: "Brand", accountHint: "@brand" });
  await importStorageState(db.client as never, { workspaceId: WS, sessionId: s.id, raw: STATE(), identity: { type: "user", id: OWNER }, actorId: OWNER });
  return attestSession(db.client as never, { workspaceId: WS, sessionId: s.id, userId: OWNER, confirm: true, allowExperimental: true });
}
const leased = (s: BrowserSessionRow, extra: Partial<TaskRow> = {}) =>
  ({ id: "t1", kind: "browser.session_check", workspace_id: WS, execution_mode: "browser", input: { sessionId: s.id }, ...extra }) as TaskRow;

describe("browser session lifecycle", () => {
  it("imports storage state encrypted, never keeping plaintext outside the secret store", async () => {
    const s = await createBrowserSession(db.client as never, { workspaceId: WS, userId: OWNER, platform: "instagram", label: "Brand", accountHint: null });
    const { session, summary } = await importStorageState(db.client as never, { workspaceId: WS, sessionId: s.id, raw: STATE(), identity: { type: "user", id: OWNER }, actorId: OWNER });
    expect(session).toMatchObject({ status: "unverified", expires_at: "2030-01-01T00:00:00.000Z" });
    expect(summary.authCookiesPresent).toBe(true);
    const everythingButCiphertext = JSON.stringify({ ...db.tables, secret_versions: [] });
    expect(everythingButCiphertext).not.toContain("live-cookie-value");
    expect(JSON.stringify(db.tables.secret_versions)).not.toContain("live-cookie-value");
    expect(db.tables.product_activity.map((a) => a.action)).toContain("browser_session.import_state");
    // re-import rotates instead of creating another secret
    await importStorageState(db.client as never, { workspaceId: WS, sessionId: s.id, raw: STATE(), identity: { type: "user", id: OWNER }, actorId: OWNER });
    expect(db.tables.secrets).toHaveLength(1);
    expect(db.tables.secrets[0].current_version).toBe(2);
  });

  it("rejects exports without a signed-in cookie or with foreign domains", async () => {
    const s = await createBrowserSession(db.client as never, { workspaceId: WS, userId: OWNER, platform: "instagram", label: "B", accountHint: null });
    await expect(importStorageState(db.client as never, { workspaceId: WS, sessionId: s.id, raw: STATE([{ name: "csrftoken", value: "x", domain: ".instagram.com", expires: 1 }]), identity: { type: "user", id: OWNER }, actorId: OWNER })).rejects.toThrow(/signed-in/);
    await expect(importStorageState(db.client as never, { workspaceId: WS, sessionId: s.id, raw: STATE([{ name: "sessionid", value: "x", domain: ".bank.example", expires: 1 }]), identity: { type: "user", id: OWNER }, actorId: OWNER })).rejects.toThrow(/does not belong/);
    await expect(importStorageState(db.client as never, { workspaceId: OTHER, sessionId: s.id, raw: STATE(), identity: { type: "user", id: OWNER }, actorId: OWNER })).rejects.toThrow(/not found/);
    expect(db.tables.secrets).toHaveLength(0);
  });

  it("requires state, attestation and the experimental opt-in before any check", async () => {
    const s = await createBrowserSession(db.client as never, { workspaceId: WS, userId: OWNER, platform: "instagram", label: "B", accountHint: null });
    expect(checkBlocker(s)).toMatch(/Import/);
    const imported = (await importStorageState(db.client as never, { workspaceId: WS, sessionId: s.id, raw: STATE(), identity: { type: "user", id: OWNER }, actorId: OWNER })).session;
    expect(checkBlocker(imported)).toMatch(/permitted use/);
    const attested = await attestSession(db.client as never, { workspaceId: WS, sessionId: s.id, userId: OWNER, confirm: true, allowExperimental: false });
    expect(checkBlocker(attested)).toMatch(/experimental/);
    await expect(requestSessionCheck(db.client as never, { workspaceId: WS, sessionId: s.id, actorId: OWNER, reason: "manual" })).rejects.toBeInstanceOf(SessionError);
    expect(db.tables.tasks).toHaveLength(0);
  });

  it("queues one idempotent browser-mode check per window", async () => {
    const s = await readySession();
    const now = new Date("2026-09-25T12:00:00Z");
    const a = await requestSessionCheck(db.client as never, { workspaceId: WS, sessionId: s.id, actorId: OWNER, reason: "manual", now });
    const b = await requestSessionCheck(db.client as never, { workspaceId: WS, sessionId: s.id, actorId: OWNER, reason: "manual", now: new Date(now.getTime() + 60_000) });
    expect(b).toEqual({ taskId: a.taskId, created: false });
    expect(db.tables.tasks[0]).toMatchObject({ kind: "browser.session_check", execution_mode: "browser", subject_type: "browser_sessions", subject_id: s.id });
  });
});

describe("worker session release", () => {
  it("releases decrypted state only for a leased browser task of the same workspace", async () => {
    const s = await readySession();
    const out = await sessionForLeasedTask(db.client as never, leased(s), "w1");
    expect(out.session).toMatchObject({ id: s.id, platform: "instagram", allowedHosts: ["instagram.com"] });
    expect(JSON.stringify(out.storageState)).toContain("live-cookie-value");
    expect(db.tables.secret_access_events.at(-1)).toMatchObject({ action: "resolve", actor_type: "worker", outcome: "success" });
    await expect(sessionForLeasedTask(db.client as never, leased(s, { workspace_id: OTHER }), "w1")).rejects.toThrow(/not found/);
    await expect(sessionForLeasedTask(db.client as never, leased(s, { kind: "content.publish" }), "w1")).rejects.toThrow(/does not use/);
    await expect(sessionForLeasedTask(db.client as never, leased(s, { input: {} }), "w1")).rejects.toThrow(/no browser session/);
  });

  it("refuses once attestation is withdrawn or the session is revoked (state crypto-shredded)", async () => {
    const s = await readySession();
    await requestSessionCheck(db.client as never, { workspaceId: WS, sessionId: s.id, actorId: OWNER, reason: "manual" });
    await revokeBrowserSession(db.client as never, { workspaceId: WS, sessionId: s.id, userId: OWNER });
    expect(db.tables.secret_versions).toHaveLength(0);
    expect(db.tables.tasks[0].state).toBe("cancelled");
    await expect(sessionForLeasedTask(db.client as never, leased(s), "w1")).rejects.toThrow(/revoked/);
  });
});

describe("session reports", () => {
  it("records health, notifies owners once on human states, and re-encrypts refreshed cookies", async () => {
    const s = await readySession();
    await reportSessionState(db.client as never, leased(s), "w1", { state: "challenge_required", reason: "checkpoint" });
    await reportSessionState(db.client as never, leased(s), "w1", { state: "challenge_required", reason: "checkpoint" });
    expect(db.tables.browser_sessions[0]).toMatchObject({ status: "challenge_required", last_error: "checkpoint" });
    expect(db.tables.operator_notifications).toHaveLength(1);
    expect(db.tables.operator_notifications[0]).toMatchObject({ entity_type: "browser_sessions", recipient_id: OWNER });
    await reportSessionState(db.client as never, leased(s), "w1", { state: "healthy", reason: "ok", storageState: STATE([{ name: "sessionid", value: "refreshed", domain: ".instagram.com", expires: 1924992000 }]) });
    expect(db.tables.browser_sessions[0]).toMatchObject({ status: "healthy", last_error: null, expires_at: "2031-01-01T00:00:00.000Z" });
    expect(db.tables.secrets[0].current_version).toBe(2);
    await expect(reportSessionState(db.client as never, leased(s), "w1", { state: "revoked", reason: "" })).rejects.toThrow(/Unknown session state/);
  });
});

describe("maintenance sweep", () => {
  it("expires sessions past cookie expiry and queues stale checks within bounds", async () => {
    const s = await readySession();
    const now = new Date("2026-09-25T12:00:00Z");
    expect(await sweepBrowserSessions(db.client as never, { BROWSER_SESSION_CHECK_HOURS: "24" }, now)).toEqual({ expired: 0, checksQueued: 1 });
    expect(await sweepBrowserSessions(db.client as never, { BROWSER_SESSION_CHECK_HOURS: "24" }, now)).toEqual({ expired: 0, checksQueued: 0 });
    db.tables.browser_sessions[0].expires_at = "2026-09-01T00:00:00Z";
    expect(await sweepBrowserSessions(db.client as never, { BROWSER_SESSION_CHECK_HOURS: "0" }, now)).toEqual({ expired: 1, checksQueued: 0 });
    expect(db.tables.browser_sessions.find((x) => x.id === s.id)?.status).toBe("expired");
  });
});
