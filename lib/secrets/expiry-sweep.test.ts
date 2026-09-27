import { describe, expect, it } from "vitest";
import { sweepSecretExpiry } from "./expiry-sweep";
import { createMemorySupabase } from "@/lib/test/memory-supabase";

describe("sweepSecretExpiry", () => {
  it("notifies owners once per secret expiry and ignores healthy or inactive secrets", async () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const db = createMemorySupabase(
      {
        secrets: [
          { id: "00000000-0000-4000-8000-000000000001", workspace_id: "w1", name: "Soon", status: "active", expires_at: "2026-09-28T00:00:00.000Z" },
          { id: "00000000-0000-4000-8000-000000000002", workspace_id: "w1", name: "Gone", status: "active", expires_at: "2026-09-20T00:00:00.000Z" },
          { id: "00000000-0000-4000-8000-000000000003", workspace_id: "w1", name: "Later", status: "active", expires_at: "2027-01-01T00:00:00.000Z" },
          { id: "00000000-0000-4000-8000-000000000004", workspace_id: "w1", name: "Revoked", status: "revoked", expires_at: "2026-09-26T00:00:00.000Z" },
        ],
        workspace_members: [
          { workspace_id: "w1", user_id: "owner", role: "owner" },
          { workspace_id: "w1", user_id: "member", role: "member" },
        ],
        operator_notifications: [],
      },
      {
        constraints: {
          operator_notifications: (row, rows) =>
            rows.some((r) => r.workspace_id === row.workspace_id && r.recipient_id === row.recipient_id && r.dedupe_key === row.dedupe_key) ? "23505" : null,
        },
      },
    );
    expect(await sweepSecretExpiry(db.client as never, now)).toEqual({ expiring: 2, notified: 2 });
    await sweepSecretExpiry(db.client as never, now);
    const n = db.tables.operator_notifications;
    expect(n).toHaveLength(2);
    expect(n.every((r) => r.recipient_id === "owner" && r.entity_type === "secrets")).toBe(true);
    expect(n.map((r) => r.kind).sort()).toEqual(["secret_expired", "secret_expiring"]);
  });
});
