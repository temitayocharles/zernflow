// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ApprovalQueue } from "./approval-queue";
import type { GatewayActionRequest } from "@/lib/social-gateway/types";
const request = {
  id: "r",
  action: "reply",
  status: "pending",
  requested_by_agent_id: "agent",
  risk_level: "low",
  text: "Proposed reply",
} as GatewayActionRequest;
afterEach(cleanup);
describe("approval presentation state machine", () => {
  it("does not invent an empty queue when unavailable", () => {
    render(
      <ApprovalQueue
        projection={{
          state: "unavailable",
          requests: [],
          updatedAt: null,
          error: null,
        }}
        canReview
      />,
    );
    expect(screen.getByText(/Approval queue unavailable/)).toBeTruthy();
    expect(screen.queryByText(/No pending requests/)).toBeNull();
  });
  it("disables review without permission or during degradation", () => {
    render(
      <ApprovalQueue
        projection={{
          state: "degraded",
          requests: [request],
          updatedAt: null,
          error: "Connection lost",
        }}
        canReview
        onDecision={vi.fn()}
      />,
    );
    expect(screen.queryByText("Confirm decision")).toBeNull();
  });
  it("retains pending request when execution fails", async () => {
    const decision = vi
      .fn()
      .mockRejectedValue(new Error("Gateway rejected review"));
    render(
      <ApprovalQueue
        projection={{
          state: "ready",
          requests: [request],
          updatedAt: null,
          error: null,
        }}
        canReview
        onDecision={decision}
      />,
    );
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Checked by operator" },
    });
    fireEvent.click(screen.getByText("Confirm decision"));
    await screen.findByRole("alert");
    expect(screen.getByText("reply · pending")).toBeTruthy();
    expect(decision).toHaveBeenCalledWith(
      "r",
      "approve",
      "Checked by operator",
    );
  });
  it("shows reviewed state only after confirmed matching result", async () => {
    render(
      <ApprovalQueue
        projection={{
          state: "ready",
          requests: [request],
          updatedAt: null,
          error: null,
        }}
        canReview
        onDecision={vi
          .fn()
          .mockResolvedValue({
            ...request,
            status: "approved",
            review_reason: "Checked",
            reviewed_by_ref: "operator",
          })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Checked" },
    });
    fireEvent.click(screen.getByText("Confirm decision"));
    await waitFor(() =>
      expect(screen.getByText("reply · approved")).toBeTruthy(),
    );
    expect(screen.queryByText("Confirm decision")).toBeNull();
  });
});
