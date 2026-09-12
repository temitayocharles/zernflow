"use client";
import { useState } from "react";
import {
  policySummary,
  type AutonomyPolicy,
} from "@/lib/collaboration/contracts";
export function AutonomyPolicyPanel({
  policy,
  agentRef,
  scope,
  state,
  canManage,
  onSave,
}: {
  policy: AutonomyPolicy | null;
  agentRef: string | null;
  scope: string;
  state: "ready" | "unavailable" | "degraded";
  canManage: boolean;
  onSave?: (policy: AutonomyPolicy) => Promise<AutonomyPolicy>;
}) {
  const [confirmed, setConfirmed] = useState<AutonomyPolicy | null>(policy);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = state === "ready" && canManage && !!onSave;
  return (
    <section aria-label="Agent autonomy policy" className="space-y-2">
      <h3 className="font-semibold">Agent autonomy policy</h3>
      <p>
        Agent: {agentRef ?? "Not supplied"} · Scope: {scope}
      </p>
      <p>
        {confirmed
          ? `Last confirmed policy: ${policySummary(confirmed)}`
          : "Current policy unknown; no local default is applied."}
      </p>
      {!editable ? (
        <p className="text-muted-foreground">
          Policy editing unavailable without an authorized Gateway policy
          read/write contract.
        </p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!onSave) return;
            const form = new FormData(e.currentTarget);
            const mode = String(form.get("mode"));
            const proposal: AutonomyPolicy =
              mode === "limit"
                ? {
                    mode: "limit",
                    maximumActions: Number(form.get("maximum")),
                    windowSeconds: Number(form.get("window")),
                  }
                : {
                    mode:
                      mode === "allow"
                        ? "allow"
                        : mode === "deny"
                          ? "deny"
                          : "ask",
                  };
            setBusy(true);
            setError(null);
            try {
              policySummary(proposal);
              const saved = await onSave(proposal);
              policySummary(saved);
              setConfirmed(saved);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Policy update failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Proposed mode
            <select
              name="mode"
              defaultValue={policy?.mode ?? "ask"}
              className="ml-2 rounded border border-border bg-background p-1"
            >
              {["allow", "ask", "deny", "limit"].map((mode) => (
                <option key={mode}>{mode}</option>
              ))}
            </select>
          </label>
          <label className="block">
            Limit: maximum actions
            <input
              name="maximum"
              type="number"
              min={1}
              step={1}
              defaultValue={
                policy?.mode === "limit" ? policy.maximumActions : 1
              }
              className="ml-2 rounded border border-border bg-background p-1"
            />
          </label>
          <label className="block">
            Limit window (seconds)
            <input
              name="window"
              type="number"
              min={1}
              step={1}
              defaultValue={
                policy?.mode === "limit" ? policy.windowSeconds : 60
              }
              className="ml-2 rounded border border-border bg-background p-1"
            />
          </label>
          <button
            disabled={busy}
            className="rounded border border-border px-2 py-1 disabled:opacity-50"
          >
            {busy ? "Saving policy…" : "Save policy through Gateway"}
          </button>
        </form>
      )}
      <ul className="space-y-1 text-muted-foreground">
        <li>Allow: execute only within granted scope.</li>
        <li>Ask: require human review before execution.</li>
        <li>Deny: block execution.</li>
        <li>
          Limit: enforce action count within a time window at the Gateway.
        </li>
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
