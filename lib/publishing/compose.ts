import type { PlatformProfile, ContentKind } from "./capabilities";
import type { PublishState } from "@/lib/product/types";

/** Final post text: variant body plus the tracked link where the platform renders links. */
export function composeText(body: string, trackedLink: string | null, profile: PlatformProfile | null): string {
  const text = body.trim();
  if (!trackedLink || !profile?.supportsLinks || text.includes(trackedLink)) return text;
  return `${text}\n\n${trackedLink}`;
}

/** Grapheme-aware length (emoji count as one, like most platforms). */
export function textLength(text: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (!Seg) return [...text].length;
  let n = 0;
  for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(text)) n++;
  return n;
}

export interface VariantCheckInput {
  text: string;
  kind: ContentKind;
  media: { contentType: string }[];
}

/** Returns blocking issues for publishing this variant on the platform. */
export function validateVariant(profile: PlatformProfile | null, input: VariantCheckInput): string[] {
  if (!profile) return ["This platform has no publishing profile."];
  const issues: string[] = [];
  const length = textLength(input.text);
  if (!input.text.trim() && input.media.length === 0) issues.push("Add text or media.");
  if (length > profile.maxTextLength) issues.push(`${profile.label} allows ${profile.maxTextLength} characters; this post has ${length}.`);
  if (!profile.contentKinds.includes(input.kind)) issues.push(`${profile.label} does not support ${input.kind.replace("_", " ")} content.`);
  if (profile.requiresMedia && input.media.length === 0) issues.push(`${profile.label} requires ${profile.mediaKinds.join(" or ")} media.`);
  if (input.media.length > profile.maxMedia) issues.push(`${profile.label} allows at most ${profile.maxMedia} media items.`);
  const bad = input.media.filter((m) => !profile.mediaKinds.some((k) => m.contentType.startsWith(`${k}/`)));
  if (bad.length) issues.push(`${profile.label} accepts ${profile.mediaKinds.join("/")} media only.`);
  return issues;
}

export type ContentPublishSummary = PublishState | "partially_published";

/** Aggregate state for a content item (DOMAIN_MODEL publish state machine). */
export function summarizePublishState(states: readonly PublishState[]): ContentPublishSummary {
  if (states.length === 0) return "draft";
  const has = (s: PublishState) => states.includes(s);
  const all = (s: PublishState) => states.every((x) => x === s);
  if (all("published")) return "published";
  if (has("published") && states.every((s) => s === "published" || s === "failed" || s === "cancelled")) return "partially_published";
  if (has("publishing")) return "publishing";
  if (has("queued")) return "queued";
  if (has("scheduled")) return "scheduled";
  if (all("failed")) return "failed";
  if (all("cancelled")) return "cancelled";
  if (has("published")) return "partially_published";
  if (has("failed")) return "failed";
  return "draft";
}
