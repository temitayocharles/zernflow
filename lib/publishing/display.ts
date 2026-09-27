import type { ContentPublishSummary } from "./compose";

export const STATE_LABEL: Record<ContentPublishSummary, string> = {
  draft: "Draft", scheduled: "Scheduled", queued: "Queued", publishing: "Publishing", published: "Published",
  failed: "Failed", partially_published: "Partially published", cancelled: "Cancelled",
};

export const STATE_TONE: Record<ContentPublishSummary, string> = {
  draft: "bg-muted text-muted-foreground", scheduled: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  queued: "bg-blue-500/15 text-blue-700 dark:text-blue-300", publishing: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", failed: "bg-destructive/15 text-destructive",
  partially_published: "bg-amber-500/15 text-amber-700 dark:text-amber-300", cancelled: "bg-muted text-muted-foreground",
};

export const CAMPAIGN_STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground", planned: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", paused: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-muted text-foreground", archived: "bg-muted text-muted-foreground line-through",
};

export function channelLabel(c: { platform: string; display_name?: string | null; username?: string | null }): string {
  return `${c.display_name || c.username || "Account"} · ${c.platform}`;
}

export type ReceiptStatus = "submitting" | "accepted" | "published" | "partial" | "failed" | "unknown";

export const RECEIPT_LABEL: Record<ReceiptStatus, string> = {
  submitting: "Submitting", accepted: "Accepted — awaiting confirmation", published: "Published",
  partial: "Partially published", failed: "Failed", unknown: "Outcome unknown",
};

export const RECEIPT_TONE: Record<ReceiptStatus, string> = {
  submitting: "bg-blue-500/15 text-blue-700 dark:text-blue-300", accepted: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", partial: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  failed: "bg-destructive/15 text-destructive", unknown: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

export interface ReceiptView {
  id: string;
  variant_id: string;
  idempotency_key: string;
  attempt: number;
  mode: string;
  provider: string;
  status: ReceiptStatus;
  external_url: string | null;
  error_class: string | null;
  error_message: string | null;
  created_at: string;
}

/**
 * Groups receipts per variant (newest first). `latest` is the newest attempt of the
 * variant's *current* schedule; `needsReconcile` is true when that attempt is
 * ambiguous and the variant has stopped (failed) on an API/browser route.
 */
export function receiptsByVariant<R extends ReceiptView>(
  rows: readonly R[],
  variants: readonly { id: string; idempotency_key: string | null; publish_state: string; execution_mode: string | null }[],
): Record<string, { all: R[]; latest: R | null; needsReconcile: boolean }> {
  const out: Record<string, { all: R[]; latest: R | null; needsReconcile: boolean }> = {};
  for (const v of variants) {
    const all = rows.filter((r) => r.variant_id === v.id).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.attempt - a.attempt));
    const current = all.filter((r) => r.idempotency_key === v.idempotency_key).sort((a, b) => b.attempt - a.attempt);
    const latest = current[0] ?? null;
    out[v.id] = {
      all,
      latest,
      needsReconcile:
        v.publish_state === "failed" && (v.execution_mode === "api" || v.execution_mode === "browser") && (latest?.status === "unknown" || latest?.status === "partial"),
    };
  }
  return out;
}
