import { describe, expect, it } from "vitest";
import { assertBoundWorkspace, GatewayTenancyError, resolveGatewayBinding } from "./tenancy";

const a = "10000000-0000-4000-8000-00000000000a";
const b = "10000000-0000-4000-8000-00000000000b";

describe("resolveGatewayBinding", () => {
  it("prefers the environment binding", () => {
    expect(resolveGatewayBinding({ envWorkspaceId: a, configuredRef: "default", rows: [] })).toEqual({
      status: "bound",
      workspaceId: a,
      source: "env",
    });
  });
  it("fails closed when environment and database disagree", () => {
    expect(
      resolveGatewayBinding({
        envWorkspaceId: a,
        configuredRef: "default",
        rows: [{ gateway_workspace_ref: "default", workspace_id: b }],
      }).status,
    ).toBe("conflict");
  });
  it("uses the ref-specific row before the migration default", () => {
    const binding = resolveGatewayBinding({
      configuredRef: "prod",
      rows: [
        { gateway_workspace_ref: "__deployment__", workspace_id: a },
        { gateway_workspace_ref: "prod", workspace_id: b },
      ],
    });
    expect(binding).toEqual({ status: "bound", workspaceId: b, source: "binding" });
  });
  it("is unbound with no configuration", () => {
    expect(resolveGatewayBinding({ configuredRef: "default", rows: [] })).toEqual({ status: "unbound" });
  });
  it("rejects malformed environment values", () => {
    expect(resolveGatewayBinding({ envWorkspaceId: "nope", configuredRef: "default", rows: [] }).status).toBe(
      "conflict",
    );
  });
});

describe("assertBoundWorkspace", () => {
  it("allows only the bound workspace", () => {
    const bound = { status: "bound", workspaceId: a, source: "env" } as const;
    expect(() => assertBoundWorkspace(bound, a)).not.toThrow();
    expect(() => assertBoundWorkspace(bound, b)).toThrow(GatewayTenancyError);
    expect(() => assertBoundWorkspace({ status: "unbound" }, a)).toThrow(/not bound/);
  });
});
