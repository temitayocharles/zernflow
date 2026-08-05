import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order while bounding active work", async () => {
    let active = 0;
    let peak = 0;

    const result = await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 10;
    });

    expect(result).toEqual([40, 30, 20, 10]);
    expect(peak).toBe(2);
  });

  it("does not create more workers than items", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([1, 2], 10, async (value) => {
      calls += 1;
      return value;
    });

    expect(result).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it("rejects invalid concurrency", async () => {
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
      "concurrency must be a positive integer",
    );
  });
});
