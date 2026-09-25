import type { ArtifactKind } from "@/lib/types/platform";

/**
 * Per-kind MIME allowlist (ARTIFACT_STORAGE_DESIGN §5). SVG and HTML are never
 * accepted (active content). Declared types are verified against magic bytes
 * after upload; mismatches are quarantined.
 */
export const MIME_ALLOWLIST: Record<ArtifactKind, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
  document: ["application/pdf", "text/csv", "application/json", "text/plain"],
  screenshot: ["image/png", "image/jpeg"],
  trace: ["application/zip"],
  export: ["application/zip", "application/json", "text/csv", "application/gzip"],
  import: ["application/zip", "application/json", "text/csv", "application/gzip"],
  bundle: ["application/zip", "application/json", "application/gzip"],
  report: ["application/json", "text/csv", "application/pdf", "text/plain"],
  backup: ["application/zip", "application/json", "application/gzip"],
  other: ["application/json", "text/plain", "text/csv"],
};

/** Kinds operators upload from the browser; execution artifacts come from workers/system. */
export const USER_UPLOAD_KINDS: readonly ArtifactKind[] = ["image", "video", "document", "import", "other"];
export const WORKER_UPLOAD_KINDS: readonly ArtifactKind[] = ["screenshot", "trace", "report", "export"];
/** Execution artifacts always expire (MAX_ARTIFACT_RETENTION_DAYS). */
export const EPHEMERAL_KINDS: readonly ArtifactKind[] = ["screenshot", "trace"];

export const ALL_KINDS = Object.keys(MIME_ALLOWLIST) as ArtifactKind[];

export function normalizeContentType(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

export function mimeAllowed(kind: ArtifactKind, contentType: string): boolean {
  return MIME_ALLOWLIST[kind]?.includes(normalizeContentType(contentType)) ?? false;
}

/** Stored as metadata only — never used in object keys. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 200) || "file";
}

export function contentDisposition(contentType: string, fileName: string): string {
  const inline = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/.test(contentType);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0) {
  return sig.every((b, i) => bytes[offset + i] === b);
}

function looksLikeText(bytes: Uint8Array) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.max(0, bytes.length - 4)));
  } catch {
    return false;
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  // Reject markup masquerading as text (could render as HTML/SVG if served with a sniffing client).
  return !(head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<script"));
}

/** Verifies the first bytes match the declared type. */
export function magicMatches(contentType: string, bytes: Uint8Array): boolean {
  const t = normalizeContentType(contentType);
  switch (t) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "video/mp4":
    case "video/quicktime":
      return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) || startsWith(bytes, [0x6d, 0x6f, 0x6f, 0x76], 4) || startsWith(bytes, [0x6d, 0x64, 0x61, 0x74], 4) || startsWith(bytes, [0x77, 0x69, 0x64, 0x65], 4);
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "application/pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "application/zip":
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
    case "application/gzip":
      return startsWith(bytes, [0x1f, 0x8b]);
    case "application/json": {
      if (!looksLikeText(bytes)) return false;
      const first = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^\uFEFF/, "").trimStart()[0];
      return first === "{" || first === "[";
    }
    case "text/csv":
    case "text/plain":
      return looksLikeText(bytes);
    default:
      return false;
  }
}
