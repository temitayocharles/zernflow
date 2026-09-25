import { failure, json, productContext } from "@/lib/product/api";
import { availableModes, PLATFORM_PROFILES } from "@/lib/publishing/capabilities";

/** GET → per-platform content profile and which execution modes are actually available. */
export async function GET() {
  try {
    await productContext();
    return json({
      platforms: Object.values(PLATFORM_PROFILES).map((p) => ({
        ...p,
        modes: Object.fromEntries(p.contentKinds.map((k) => [k, availableModes(p.platform, k)])),
      })),
    });
  } catch (error) {
    return failure(error);
  }
}
