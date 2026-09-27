import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/social-gateway/server", () => ({
  requireSocialGatewayClient: () => {
    throw new Error("gateway not expected in this test");
  },
}));

import { executeFlow } from "./engine";
import type { FlowExecutionContext } from "./types";

type Row = Record<string, unknown>;
type Filters = Array<[string, unknown]>;

/** Minimal chainable Supabase fake that applies eq filters to in-memory rows. */
function fakeSupabase(tables: Record<string, Row[]>) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const flowQueries: Filters[] = [];
  function builder(table: string) {
    const filters: Filters = [];
    let pendingInsert: Row | null = null;
    const matches = () =>
      (tables[table] ?? []).filter((row) => filters.every(([col, val]) => row[col] === val));
    const api = {
      select: () => api,
      insert: (row: Row) => {
        pendingInsert = row;
        inserts.push({ table, row });
        return api;
      },
      update: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      in: () => api,
      order: () => api,
      limit: () => api,
      single: async () => {
        if (table === "flows") flowQueries.push([...filters]);
        if (pendingInsert) return { data: { id: `${table}-${inserts.length}` }, error: null };
        const rows = matches();
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      },
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
      then: (resolve: (value: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
    };
    return api;
  }
  return { client: { from: builder, rpc: async () => ({ data: null, error: null }) }, inserts, flowQueries };
}

const wsA = "workspace-a";
const wsB = "workspace-b";

function context(overrides: Partial<FlowExecutionContext> = {}): FlowExecutionContext {
  return {
    flowId: "flow-a",
    workspaceId: wsA,
    contactId: "contact-a",
    channelId: "channel-a",
    conversationId: "conversation-a",
    triggerId: "trigger-a",
    incomingMessage: { text: "hi" },
    variables: {},
    ...overrides,
  } as FlowExecutionContext;
}

function flow(id: string, workspaceId: string, action: Row) {
  return {
    id,
    workspace_id: workspaceId,
    status: "published",
    nodes: [
      { id: "t", type: "trigger", data: {}, position: { x: 0, y: 0 } },
      { id: "n", ...action, position: { x: 0, y: 0 } },
    ],
    edges: [{ id: "e", source: "t", target: "n" }],
  };
}

describe("flow engine tenant scoping", () => {
  it("never executes a goToFlow target owned by another workspace", async () => {
    const { client, inserts, flowQueries } = fakeSupabase({
      flows: [
        flow("flow-a", wsA, { type: "goToFlow", data: { flowId: "flow-b" } }),
        flow("flow-b", wsB, { type: "tag", data: { action: "add", tagId: "tag-b" } }),
      ],
    });
    await executeFlow(client as any, context());
    const sessions = inserts.filter((i) => i.table === "flow_sessions").map((i) => i.row.flow_id);
    expect(sessions).toEqual(["flow-a"]);
    expect(flowQueries.every((filters) => filters.some(([c, v]) => c === "workspace_id" && v === wsA))).toBe(true);
  });

  it("still executes a goToFlow target in the same workspace", async () => {
    const { client, inserts } = fakeSupabase({
      flows: [
        flow("flow-a", wsA, { type: "goToFlow", data: { flowId: "flow-c" } }),
        flow("flow-c", wsA, { type: "tag", data: { action: "add", tagId: "tag-a" } }),
      ],
    });
    await executeFlow(client as any, context());
    const sessions = inserts.filter((i) => i.table === "flow_sessions").map((i) => i.row.flow_id);
    expect(sessions).toEqual(["flow-a", "flow-c"]);
  });

  it("refuses HTTP node requests to internal metadata addresses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client } = fakeSupabase({
      flows: [
        flow("flow-a", wsA, {
          type: "httpRequest",
          data: { url: "http://169.254.169.254/latest/meta-data", method: "GET", responseVariable: "r" },
        }),
      ],
    });
    const ctx = context();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await executeFlow(client as any, ctx);
    expect(ctx.variables?.r).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("HTTP request node failed", expect.objectContaining({ reason: "unsafe_url" }));
    errors.mockRestore();
    fetchSpy.mockRestore();
  });
});
