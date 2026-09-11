import { describe, expect, it } from "vitest";
import { durationLabel, parseOperatorMetrics } from "./operator-metrics";
describe("operator metrics presentation", () => {
  it("does not invent timing for empty samples", () => {
    expect(durationLabel(null)).toBe("No recorded samples");
    expect(durationLabel(120)).toBe("2 minutes");
  });
  it("rejects missing and malformed aggregate responses", () => {
    expect(() => parseOperatorMetrics({})).toThrow();
    expect(() => parseOperatorMetrics({ work_items: { total: -1 } })).toThrow();
  });
});
