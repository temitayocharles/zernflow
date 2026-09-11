// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutonomyPolicyPanel } from "./autonomy-policy";
afterEach(cleanup);
describe("autonomy policy confirmation", () => {
  it("does not display a default as applied policy", () => {
    render(
      <AutonomyPolicyPanel
        policy={null}
        agentRef={null}
        scope="conversation"
        state="unavailable"
        canManage
      />,
    );
    expect(screen.getByText(/Current policy unknown/)).toBeTruthy();
    expect(screen.queryByText("Save policy through Gateway")).toBeNull();
  });
  it("does not replace confirmed policy after rejected write", async () => {
    render(
      <AutonomyPolicyPanel
        policy={{ mode: "deny" }}
        agentRef="a"
        scope="conversation"
        state="ready"
        canManage
        onSave={vi.fn().mockRejectedValue(new Error("Forbidden"))}
      />,
    );
    fireEvent.change(screen.getByLabelText("Proposed mode"), {
      target: { value: "allow" },
    });
    fireEvent.click(screen.getByText("Save policy through Gateway"));
    await screen.findByRole("alert");
    expect(
      screen.getByText("Last confirmed policy: Deny execution"),
    ).toBeTruthy();
  });
});
