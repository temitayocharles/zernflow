import { failure, json, productContext, readJson } from "@/lib/product/api";
import { InputError, object, text, uuid } from "@/lib/product/validation";
import { rpcFailure } from "@/lib/publishing/http";

/**
 * POST { outcome: "published" | "not_published", externalUrl?, externalRef? }
 * Operator reconciles an API/browser publication whose outcome is unknown or partial (R10).
 */
export async function POST(request: Request, { params }: { params: Promise<{ variantId: string }> }) {
  try {
    const variantId = uuid((await params).variantId, "variant id");
    const { supabase } = await productContext();
    const body = object(await readJson(request, 8192));
    const outcome = body.outcome;
    if (outcome !== "published" && outcome !== "not_published") throw new InputError("outcome must be published or not_published");
    const { data, error } = await supabase.rpc("resolve_publication", {
      p_variant: variantId,
      p_outcome: outcome,
      p_external_url: outcome === "published" ? text(body.externalUrl, "externalUrl", 2000, true) : null,
      p_external_ref: outcome === "published" && body.externalRef ? text(body.externalRef, "externalRef", 300) : null,
    });
    rpcFailure(error);
    return json({ state: data });
  } catch (error) {
    return failure(error);
  }
}
