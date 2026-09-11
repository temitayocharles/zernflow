import { describe, expect, it } from "vitest";
import { summarizePublishing, type PublishingOutcome } from "./contracts";
const outcome: PublishingOutcome = {
  channelId: "c",
  state: "published",
  operationId: "o",
  externalReference: "p",
  error: null,
  occurredAt: "2026-09-11T00:00:00Z",
};
describe("publishing results", () => {
  it("does not mistake empty outcomes for publication", () =>
    expect(summarizePublishing([])).toBe("not_dispatched"));
  it("preserves per-channel failure", () =>
    expect(
      summarizePublishing([outcome, { ...outcome, state: "failed" }]),
    ).toBe("failed"));
  it("only reports published after all channels confirm", () => {
    expect(
      summarizePublishing([outcome, { ...outcome, state: "queued" }]),
    ).toBe("queued");
    expect(summarizePublishing([outcome])).toBe("published");
  });
});
