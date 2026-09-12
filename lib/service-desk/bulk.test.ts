import { describe, expect, it } from "vitest";
import { parseBulkWorkChanges } from "./bulk";
const id = "00000000-0000-4000-8000-000000000001";
const change = { id, version: 1, status: "resolved" };
describe("bulk work boundaries", () => {
  it("accepts bounded versioned status/priority changes", () =>
    expect(parseBulkWorkChanges({ changes: [change] })).toEqual([change]));
  it.each([
    [],
    Array(51).fill(change),
    [change, change],
    [{ ...change, workspace_id: "other" }],
    [{ ...change, version: 0 }],
    [{ id, version: 1 }],
  ])("rejects unsafe bulk input %j", (changes) =>
    expect(() => parseBulkWorkChanges({ changes })).toThrow(),
  );
});
