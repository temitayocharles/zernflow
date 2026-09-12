"use client";
import { useState } from "react";
import type { ApprovalQueueProjection } from "@/lib/collaboration/contracts";
import type { GatewayActionRequest } from "@/lib/social-gateway/types";
export type ApprovalDecision = (
  requestId: string,
  decision: "approve" | "reject",
  reason: string,
) => Promise<GatewayActionRequest>;
/** Read/decision callbacks must be wired only after request-to-workspace authorization is verified. */
export function ApprovalQueue({
  projection,
  canReview,
  onDecision,
}: {
  projection: ApprovalQueueProjection;
  canReview: boolean;
  onDecision?: ApprovalDecision;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<
    Record<string, GatewayActionRequest>
  >({});
  const actionable = projection.state === "ready" && canReview && !!onDecision;
  async function decide(
    event: React.FormEvent<HTMLFormElement>,
    request: GatewayActionRequest,
  ) {
    event.preventDefault();
    if (!actionable || busy || !onDecision) return;
    const form = new FormData(event.currentTarget);
    const decision = form.get("decision") === "reject" ? "reject" : "approve";
    const reason = String(form.get("reason") ?? "").trim();
    if (!reason) {
      setError("A decision reason is required");
      return;
    }
    setBusy(request.id);
    setError(null);
    try {
      const result = await onDecision(request.id, decision, reason);
      if (
        result.id !== request.id ||
        !(
          decision === "approve" ? ["approved", "dispatched"] : ["rejected"]
        ).includes(result.status)
      )
        throw new Error(
          "The review was not confirmed. Refresh before retrying.",
        );
      setReviewed((current) => ({ ...current, [result.id]: result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval review failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-label="Approval queue" className="space-y-3">
      <h3 className="font-semibold">Approval queue</h3>
      {projection.state === "unavailable" ? (
        <p className="text-muted-foreground">
          Approval queue unavailable: a verified workspace-scoped request-read
          contract is required. No pending count or decision is assumed.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {projection.state === "degraded"
              ? "Queue is degraded; decisions are disabled."
              : "Gateway request projection"}
            {projection.updatedAt
              ? ` · Updated ${new Date(projection.updatedAt).toLocaleString()}`
              : ""}
          </p>
          {projection.error && <p role="alert">{projection.error}</p>}
          {!actionable && (
            <p className="text-muted-foreground">
              Read-only: review permission or verified decision integration is
              unavailable.
            </p>
          )}
          {projection.requests.map((original) => {
            const request = reviewed[original.id] ?? original;
            return (
              <article
                key={request.id}
                className="space-y-2 rounded border border-border p-3"
              >
                <p className="font-medium">
                  {request.action} · {request.status}
                </p>
                <p className="text-muted-foreground">
                  Agent {request.requested_by_agent_id} · Risk{" "}
                  {request.risk_level}
                </p>
                <p className="whitespace-pre-wrap">{request.text}</p>
                {request.status === "pending" && actionable ? (
                  <form
                    onSubmit={(e) => decide(e, request)}
                    className="space-y-2"
                  >
                    <label className="block">
                      Decision reason
                      <textarea
                        name="reason"
                        required
                        maxLength={2000}
                        className="mt-1 w-full rounded border border-border bg-background p-2"
                      />
                    </label>
                    <label>
                      Decision
                      <select
                        name="decision"
                        className="ml-2 rounded border border-border bg-background p-1"
                      >
                        <option value="approve">Approve</option>
                        <option value="reject">Reject</option>
                      </select>
                    </label>
                    <button
                      disabled={busy !== null}
                      className="ml-2 rounded border border-border px-2 py-1 disabled:opacity-50"
                    >
                      {busy === request.id ? "Reviewing…" : "Confirm decision"}
                    </button>
                  </form>
                ) : (
                  request.review_reason && (
                    <p>
                      Reviewed by{" "}
                      {request.reviewed_by_ref ?? "Gateway reviewer"}:{" "}
                      {request.review_reason}
                    </p>
                  )
                )}
              </article>
            );
          })}
          {!projection.requests.length && (
            <p>No pending requests in this authorized projection.</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
