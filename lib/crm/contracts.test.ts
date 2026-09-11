import { describe, expect, it } from "vitest";
import { parseCrmInput } from "./contracts";
describe("CRM input boundaries", () => {
  it("validates company creation", () =>
    expect(
      parseCrmInput("companies", { name: " Acme ", lifecycle: "customer" }),
    ).toEqual({ name: "Acme", lifecycle: "customer" }));
  it.each([
    null,
    [],
    { name: "" },
    { name: "X", workspace_id: "foreign" },
    { name: "X", owner_id: "bad" },
    { name: "X", lifecycle: "fake" },
  ])("rejects invalid input %j", (v) =>
    expect(() => parseCrmInput("companies", v)).toThrow(),
  );
  it("requires optimistic version on updates", () =>
    expect(() => parseCrmInput("deals", { stage: "won" }, true)).toThrow(
      "version",
    ));
  it("rejects unsafe monetary values", () =>
    expect(() =>
      parseCrmInput("deals", {
        name: "X",
        value_minor: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow());
  it("bounds score and prevents contact relinking", () => {
    expect(() =>
      parseCrmInput("customer_profiles", { version: 1, lead_score: 101 }, true),
    ).toThrow();
    expect(() =>
      parseCrmInput("customer_profiles", { version: 1, contact_id: "a" }, true),
    ).toThrow();
  });
});
