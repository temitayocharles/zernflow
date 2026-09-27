import "server-only";
import type { Json } from "@/lib/types/database";
import type { CampaignRow, ErrorClass, TaskRow } from "@/lib/types/platform";
import type { EditorialDraft, EditorialVariant, PublishState } from "@/lib/product/types";
import type { ServiceClient, TaskHandler } from "@/lib/tasks/types";
import { TaskError, decisionFor, classifyError } from "@/lib/tasks/errors";
import { InputError } from "@/lib/product/validation";
import { getObjectStore, objectStoreConfigured } from "@/lib/storage";
import { buildTrackedLink } from "./utm";
import { composeText, validateVariant } from "./compose";
import { profileFor, resolveMode, type PublishMode } from "./capabilities";
import { apiProviderFor, apiRouteReason } from "./contract";
import { recordRemoteReceipt, runApiPublish } from "./engine";

type AnyClient = ServiceClient;

export interface PublishContext {
  draft: EditorialDraft;
  variants: (EditorialVariant & { platform: string; channelLabel: string; accountRef: string })[];
  campaign: Pick<CampaignRow, "id" | "name" | "utm_defaults" | "requires_approval" | "status"> | null;
  assets: { id: string; content_type: string; object_key: string; kind: string }[];
}

/** Loads a content item with variants, channels, campaign and assets, scoped to the workspace. */
export async function loadPublishContext(client: AnyClient, workspaceId: string, draftId: string): Promise<PublishContext | null> {
  const { data: draft } = await client.from("editorial_drafts").select("*").eq("workspace_id", workspaceId).eq("id", draftId).maybeSingle();
  if (!draft) return null;
  const d = draft as unknown as EditorialDraft;
  const [{ data: variants }, campaignRes, assetsRes] = await Promise.all([
    client.from("editorial_variants").select("*").eq("workspace_id", workspaceId).eq("draft_id", draftId).order("created_at"),
    d.campaign_id
      ? client.from("campaigns").select("id, name, utm_defaults, requires_approval, status").eq("workspace_id", workspaceId).eq("id", d.campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
    d.asset_ids?.length
      ? client.from("artifacts").select("id, content_type, object_key, kind").eq("workspace_id", workspaceId).eq("status", "available").in("id", d.asset_ids)
      : Promise.resolve({ data: [] }),
  ]);
  const vs = (variants ?? []) as unknown as EditorialVariant[];
  const channelIds = [...new Set(vs.map((v) => v.channel_id))];
  const { data: channels } = channelIds.length
    ? await client.from("channels").select("id, platform, username, display_name, late_account_id").eq("workspace_id", workspaceId).in("id", channelIds)
    : { data: [] as { id: string; platform: string; username: string | null; display_name: string | null; late_account_id: string }[] };
  const byId = new Map((channels ?? []).map((c) => [c.id, c]));
  // Preserve the draft's asset order.
  const assetRows = (assetsRes.data ?? []) as PublishContext["assets"];
  const assets = (d.asset_ids ?? []).map((id) => assetRows.find((a) => a.id === id)).filter((a): a is PublishContext["assets"][number] => Boolean(a));
  return {
    draft: d,
    campaign: (campaignRes.data as PublishContext["campaign"]) ?? null,
    assets,
    variants: vs.map((v) => {
      const ch = byId.get(v.channel_id);
      return {
        ...v,
        platform: ch?.platform ?? "unknown",
        channelLabel: ch ? `${ch.platform} · ${ch.display_name || ch.username || ch.late_account_id}` : "Unknown channel",
        accountRef: ch?.late_account_id ?? "",
      };
    }),
  };
}

export function variantText(ctx: PublishContext, variant: PublishContext["variants"][number]): { text: string; trackedLink: string | null } {
  const trackedLink = buildTrackedLink(ctx.draft.link_url, {
    campaignName: ctx.campaign?.name,
    campaignUtm: ctx.campaign?.utm_defaults,
    contentUtm: ctx.draft.utm,
    platform: variant.platform,
    variantId: variant.id,
  });
  return { text: composeText(variant.body || ctx.draft.body, trackedLink, profileFor(variant.platform)), trackedLink };
}

export function variantIssues(ctx: PublishContext, variant: PublishContext["variants"][number]): string[] {
  return validateVariant(profileFor(variant.platform), {
    text: variantText(ctx, variant).text,
    kind: ctx.draft.kind,
    media: ctx.assets.map((a) => ({ contentType: a.content_type })),
  });
}

export interface SchedulePlan {
  plan: { variantId: string; mode: PublishMode }[];
  blocked: { variantId: string; channel: string; issues: string[] }[];
}

/** Validates variants against platform profiles and resolves execution modes (API first). */
export function planSchedule(ctx: PublishContext, opts: { variantIds?: string[]; modes?: Record<string, PublishMode> } = {}): SchedulePlan {
  const eligible: PublishState[] = ["draft", "failed", "cancelled"];
  const selected = ctx.variants.filter((v) => (opts.variantIds ? opts.variantIds.includes(v.id) : eligible.includes(v.publish_state)));
  if (opts.variantIds && selected.length !== opts.variantIds.length) throw new InputError("Unknown variant for this content");
  const result: SchedulePlan = { plan: [], blocked: [] };
  for (const v of selected) {
    const issues = [...variantIssues(ctx, v)];
    if (!eligible.includes(v.publish_state)) issues.push(`Variant is ${v.publish_state}.`);
    const mode = resolveMode(v.platform, ctx.draft.kind, opts.modes?.[v.id]);
    if ("error" in mode) issues.push(mode.error);
    if (issues.length || "error" in mode) result.blocked.push({ variantId: v.id, channel: v.channelLabel, issues });
    else result.plan.push({ variantId: v.id, mode: mode.mode });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function setVariant(client: AnyClient, workspaceId: string, variantId: string, patch: Record<string, unknown>) {
  const { error } = await client.from("editorial_variants").update(patch).eq("workspace_id", workspaceId).eq("id", variantId);
  if (error) throw new TaskError("internal", `variant update failed (${error.code ?? "unknown"})`);
}

function httpsOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

interface PublishInput extends Record<string, unknown> {
  variantId: string;
  draftId: string;
  channelId: string;
  mode: PublishMode;
}

/** `content.publish` for API-mode variants (runs in the tick). Browser mode runs on remote executors. */
export const contentPublishHandler: TaskHandler<PublishInput> = {
  kind: "content.publish",
  title: "Publish content",
  description: "Publishes one channel variant of a content item through its connected adapter.",
  mode: "api",
  schedulable: false,
  userRunnable: false,
  parseInput(input) {
    const i = (input ?? {}) as Record<string, unknown>;
    for (const k of ["variantId", "draftId", "channelId"]) if (typeof i[k] !== "string") throw new TaskError("validation", `${k} missing`);
    if (!["api", "browser", "manual"].includes(i.mode as string)) throw new TaskError("validation", "mode missing");
    return i as PublishInput;
  },
  async run(ctx, input) {
    const { task, supabase } = ctx;
    const pc = await loadPublishContext(supabase, task.workspace_id, input.draftId);
    const variant = pc?.variants.find((v) => v.id === input.variantId);
    if (!pc || !variant) return { status: "completed", result: { skipped: "content_deleted" } };
    // Stale task (content was unscheduled/rescheduled) or already settled elsewhere.
    // `publishing` is resumable: the engine polls an accepted operation or stops on an ambiguous attempt.
    if (variant.idempotency_key !== task.idempotency_key || !["scheduled", "queued", "failed", "publishing"].includes(variant.publish_state)) {
      return { status: "completed", result: { skipped: `variant_${variant.publish_state}` } };
    }
    if (input.mode !== "api") throw new TaskError("validation", `mode ${input.mode} is not executed by the tick`);
    const provider = apiProviderFor(variant.platform, pc.draft.kind);
    if (!provider) {
      const reason = apiRouteReason(variant.platform, pc.draft.kind).reason;
      if (variant.publish_state !== "publishing") {
        await setVariant(supabase, task.workspace_id, variant.id, {
          publish_state: "failed",
          last_error: `${reason} Reschedule as manual or browser.`.slice(0, 1000),
        });
      }
      throw new TaskError("unsupported_capability", `No API publishing provider for ${variant.platform}: ${reason}`);
    }
    const issues = variant.publish_state === "publishing" ? [] : variantIssues(pc, variant);
    if (issues.length) {
      await setVariant(supabase, task.workspace_id, variant.id, { publish_state: "failed", last_error: issues.join(" ").slice(0, 1000) });
      throw new TaskError("validation", issues.join(" "), { terminal: true });
    }

    const store = pc.assets.length && objectStoreConfigured() ? getObjectStore() : null;
    if (pc.assets.length && !store) throw new TaskError("unsupported_capability", "Artifact storage is not configured; media cannot be delivered");
    return runApiPublish(ctx, {
      provider,
      platform: variant.platform,
      variant: { id: variant.id, channel_id: variant.channel_id, publish_state: variant.publish_state, attempt_count: variant.attempt_count },
      request: {
        workspaceId: task.workspace_id,
        variantId: variant.id,
        channelId: variant.channel_id,
        accountRef: variant.accountRef,
        platform: variant.platform,
        kind: pc.draft.kind,
        text: variantText(pc, variant).text,
        media: store
          ? await Promise.all(
              pc.assets.map(async (a) => ({
                artifactId: a.id,
                contentType: a.content_type,
                url: await store.presignGet(a.object_key, { expiresInSeconds: 3600, contentType: a.content_type, disposition: "inline" }),
              })),
            )
          : [],
        idempotencyKey: task.idempotency_key,
      },
    });
  },
};

/** Applies a remote (browser) worker's outcome to the variant. Called from worker complete/fail routes. */
export async function settleRemotePublish(
  client: AnyClient,
  task: Pick<TaskRow, "id" | "kind" | "workspace_id" | "input" | "idempotency_key"> & { attempts?: number },
  outcome: { status: "completed"; result: unknown } | { status: "failed" | "retrying" | "waiting_for_user"; message: string; errorClass?: ErrorClass },
): Promise<void> {
  if (task.kind !== "content.publish") return;
  const variantId = (task.input as { variantId?: string } | null)?.variantId;
  if (!variantId) return;
  const { data: v } = await client
    .from("editorial_variants")
    .select("id, publish_state, idempotency_key, channel_id")
    .eq("workspace_id", task.workspace_id)
    .eq("id", variantId)
    .maybeSingle();
  if (!v || v.idempotency_key !== task.idempotency_key) return;
  const receipt = async (
    status: "published" | "failed" | "unknown",
    extra: { externalRef?: string | null; externalUrl?: string | null; message?: string | null; errorClass?: ErrorClass | null },
  ) => {
    const { data: ch } = await client.from("channels").select("platform").eq("workspace_id", task.workspace_id).eq("id", v.channel_id).maybeSingle();
    await recordRemoteReceipt(client, {
      workspaceId: task.workspace_id, variantId: v.id, taskId: task.id, idempotencyKey: task.idempotency_key,
      attempt: task.attempts ?? 1, provider: `browser:${ch?.platform ?? "unknown"}`, status, ...extra,
    }).catch(() => undefined);
  };
  const stepTo = async (target: PublishState, patch: Record<string, unknown> = {}) => {
    // Walk legal transitions: scheduled/queued → publishing → target.
    if (["scheduled", "queued"].includes(v.publish_state) && target !== "queued") await setVariant(client, task.workspace_id, v.id, { publish_state: "publishing" });
    if (v.publish_state === "failed" && target === "published") {
      await setVariant(client, task.workspace_id, v.id, { publish_state: "scheduled" });
      await setVariant(client, task.workspace_id, v.id, { publish_state: "publishing" });
    }
    await setVariant(client, task.workspace_id, v.id, { publish_state: target, ...patch });
  };
  if (outcome.status === "completed") {
    const r = (outcome.result ?? {}) as { externalRef?: unknown; externalUrl?: unknown };
    const externalRef = typeof r.externalRef === "string" ? r.externalRef.slice(0, 300) : null;
    await stepTo("published", { external_ref: externalRef, external_url: httpsOrNull(r.externalUrl), last_error: null });
    await receipt("published", { externalRef, externalUrl: httpsOrNull(r.externalUrl) });
  } else if (outcome.status === "retrying") {
    await receipt(outcome.errorClass === "unknown_outcome" ? "unknown" : "failed", { message: outcome.message, errorClass: outcome.errorClass ?? null });
    if (v.publish_state !== "queued") await setVariant(client, task.workspace_id, v.id, { publish_state: v.publish_state === "publishing" ? "queued" : v.publish_state, last_error: outcome.message.slice(0, 1000) });
  } else {
    await receipt(outcome.errorClass === "unknown_outcome" ? "unknown" : "failed", { message: outcome.message, errorClass: outcome.errorClass ?? null });
    if (v.publish_state !== "failed") await stepTo("failed", { last_error: outcome.message.slice(0, 1000) });
  }
}
