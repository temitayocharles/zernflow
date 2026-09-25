import { failure, json, productContext, readJson } from "@/lib/product/api";
import { object, text, uuid } from "@/lib/product/validation";
import { rpcFailure } from "@/lib/publishing/http";

/** POST { externalUrl, externalRef? } — operator confirms a manual publication. */
export async function POST(request: Request, { params }: { params: Promise<{ variantId: string }> }) {
  try {
    const variantId = uuid((await params).variantId, "variant id");
    const { supabase } = await productContext();
    const body = object(await readJson(request, 8192));
    const { data, error } = await supabase.rpc("confirm_manual_publication", {
      p_variant: variantId,
      p_external_url: text(body.externalUrl, "externalUrl", 2000, true),
      p_external_ref: body.externalRef ? text(body.externalRef, "externalRef", 300) : null,
    });
    rpcFailure(error);
    return json({ state: data });
  } catch (error) {
    return failure(error);
  }
}
