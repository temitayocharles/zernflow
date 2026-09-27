import { ApiError, failure, json, productContext, readJson } from "@/lib/product/api";
import { InputError, object, timestamp, uuid } from "@/lib/product/validation";
import { loadPublishContext, planSchedule } from "@/lib/publishing/service";
import { rpcFailure } from "@/lib/publishing/http";
import type { PublishMode } from "@/lib/publishing/capabilities";
import type { ServiceClient } from "@/lib/tasks/types";

/**
 * POST { at?, variantIds?, modes?: {variantId: mode}, dryRun? }
 * Validates variants against platform capabilities, resolves execution modes
 * (API → browser → manual), then schedules through the approval-checking RPC
 * as the signed-in user. Blocked variants are reported, never silently dropped.
 */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const draftId = uuid((await params).draftId, "content id");
    const { supabase, workspaceId } = await productContext();
    const body = object(await readJson(request, 16384));
    const at = body.at === undefined || body.at === null || body.at === "" ? null : timestamp(body.at, "at");
    const variantIds = body.variantIds === undefined ? undefined : (Array.isArray(body.variantIds) ? body.variantIds : []).map((v) => uuid(v, "variant id"));
    const modes: Record<string, PublishMode> = {};
    if (body.modes !== undefined) {
      for (const [k, v] of Object.entries(object(body.modes))) {
        if (!["api", "browser", "manual"].includes(v as string)) throw new InputError("Invalid mode");
        modes[uuid(k, "variant id")] = v as PublishMode;
      }
    }
    const ctx = await loadPublishContext(supabase as unknown as ServiceClient, workspaceId, draftId);
    if (!ctx) throw new ApiError(404, "Content not found");
    const plan = planSchedule(ctx, { variantIds, modes });
    if (body.dryRun === true || plan.plan.length === 0) {
      return json({ scheduled: 0, plan: plan.plan, blocked: plan.blocked }, plan.plan.length === 0 && body.dryRun !== true ? 422 : 200);
    }
    if (plan.blocked.length && body.allowPartial !== true) {
      return json({ scheduled: 0, plan: plan.plan, blocked: plan.blocked, error: "Some variants cannot be published; fix them or schedule the rest with allowPartial." }, 422);
    }
    const { data, error } = await supabase.rpc("schedule_content_item", { p_draft: draftId, p_at: at, p_plan: plan.plan });
    rpcFailure(error);
    return json({ scheduled: data ?? 0, plan: plan.plan, blocked: plan.blocked });
  } catch (error) {
    return failure(error);
  }
}
