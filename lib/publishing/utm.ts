/** UTM tracked links for campaign attribution. Only http(s) URLs are accepted. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmParams = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Accepts {source, medium, ...} or {utm_source, ...}; drops unknown keys and non-strings. */
export function normalizeUtm(value: unknown): UtmParams {
  const out: UtmParams = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = (k.startsWith("utm_") ? k : `utm_${k}`) as (typeof UTM_KEYS)[number];
    if (UTM_KEYS.includes(key) && typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 200);
  }
  return out;
}

export function buildTrackedLink(
  linkUrl: string | null | undefined,
  opts: { campaignName?: string | null; campaignUtm?: unknown; contentUtm?: unknown; platform: string; variantId?: string },
): string | null {
  if (!linkUrl) return null;
  let url: URL;
  try {
    url = new URL(linkUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const params: UtmParams = {
    utm_source: opts.platform,
    utm_medium: "social",
    ...(opts.campaignName ? { utm_campaign: slugify(opts.campaignName) } : {}),
    ...(opts.variantId ? { utm_content: opts.variantId.slice(0, 8) } : {}),
    ...normalizeUtm(opts.campaignUtm),
    ...normalizeUtm(opts.contentUtm),
  };
  for (const [k, v] of Object.entries(params)) {
    if (v && !url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  return url.toString();
}
