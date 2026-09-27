import { failure, json, productContext } from "@/lib/product/api";
import { object, uuid } from "@/lib/product/validation";
import { rpcFailure } from "@/lib/publishing/http";

/** POST { variantId? } → back to draft; queued jobs are cancelled. Publishing variants cannot be pulled back. */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const draftId = uuid((await params).draftId, "content id");
    const { supabase } = await productContext();
    const raw = await request.text();
    if (raw.length > 4096) throw new SyntaxError("body too large");
    const body = raw.trim() ? object(JSON.parse(raw)) : {};
    const { data, error } = await supabase.rpc("unschedule_content_item", {
      p_draft: draftId,
      p_variant: body.variantId ? uuid(body.variantId, "variant id") : null,
    });
    rpcFailure(error);
    return json({ unscheduled: data ?? 0 });
  } catch (error) {
    return failure(error);
  }
}
