export type PublishingState =
  | "draft"
  | "in_review"
  | "approved"
  | "scheduled"
  | "queued"
  | "publishing"
  | "published"
  | "failed";
export interface PublishingVariant {
  channelId: string;
  text: string;
  mediaRefs: string[];
}
export interface PublishingOutcome {
  channelId: string;
  state: PublishingState;
  operationId: string | null;
  externalReference: string | null;
  error: { code: string; message: string } | null;
  occurredAt: string;
}
export interface PublishingRequest {
  workspaceId: string;
  draftId: string;
  version: number;
  variants: PublishingVariant[];
  scheduledAt: string | null;
  timezone: string;
  idempotencyKey: string;
}
/** Gateway or maintained connector owns durable execution and retry semantics. */
export interface PublishingExecutor {
  submit(request: PublishingRequest): Promise<PublishingOutcome[]>;
  reconcile(operationId: string): Promise<PublishingOutcome>;
}
export function summarizePublishing(
  outcomes: readonly PublishingOutcome[],
): PublishingState | "not_dispatched" {
  if (!outcomes.length) return "not_dispatched";
  if (outcomes.every((o) => o.state === "published")) return "published";
  if (outcomes.some((o) => o.state === "failed")) return "failed";
  if (outcomes.some((o) => o.state === "publishing")) return "publishing";
  if (outcomes.some((o) => o.state === "queued")) return "queued";
  if (outcomes.some((o) => o.state === "scheduled")) return "scheduled";
  return "draft";
}
