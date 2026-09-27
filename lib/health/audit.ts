/** Pure merge for the unified audit log (record activity + secret access events). */
export interface AuditEntry {
  id: string;
  source: "records" | "secrets";
  at: string;
  actorId: string | null;
  actorType: "user" | "service" | "worker" | "system";
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: "success" | "denied" | "error";
  detail: string;
}

export function mergeAudit(records: AuditEntry[], secrets: AuditEntry[], limit: number): { entries: AuditEntry[]; nextBefore: string | null } {
  const all = [...records, ...secrets].sort(compareAudit);
  const entries = all.slice(0, limit);
  return { entries, nextBefore: all.length > limit ? encodeAuditCursor(entries[entries.length - 1]) : null };
}

/** Newest first by (timestamp, id): the same total order the keyset filter below uses. */
function compareAudit(a: AuditEntry, b: AuditEntry): number {
  const ta = instantKey(a.at);
  const tb = instantKey(b.at);
  if (ta !== tb) return ta < tb ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/**
 * Comparable key with microsecond precision. Postgres timestamps carry
 * microseconds that `Date` would truncate, which is how rows were skipped or
 * repeated at page boundaries; the raw string is kept end-to-end instead.
 */
function instantKey(at: string): string {
  const m = TIMESTAMP.exec(at);
  if (!m) return at;
  const ms = Date.parse(`${m[1]}Z`) - offsetMinutes(m[3]) * 60_000;
  return `${String(ms).padStart(15, "0")}${(m[2] ?? "").padEnd(6, "0").slice(3, 6)}`;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?)(Z|[+-]\d{2}(?::?\d{2})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function offsetMinutes(z: string): number {
  if (z === "Z") return 0;
  const sign = z.startsWith("-") ? -1 : 1;
  const digits = z.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0"));
}

export interface AuditCursor {
  at: string;
  id: string | null;
}

export function encodeAuditCursor(e: Pick<AuditEntry, "at" | "id">): string {
  return `${e.at}|${e.id}`;
}

/** Accepts "<timestamp>|<uuid>" and, for old links, a bare timestamp. Returns null for anything else. */
export function parseAuditCursor(raw: string | undefined | null): AuditCursor | null {
  if (!raw || raw.length > 100) return null;
  const [at, id, extra] = raw.split("|");
  if (extra !== undefined || !TIMESTAMP.test(at)) return null;
  if (id === undefined) return { at, id: null };
  return UUID.test(id) ? { at, id: id.toLowerCase() } : null;
}

/**
 * PostgREST filter for rows strictly older than the cursor in (created_at desc, id desc)
 * order. Values are validated by `parseAuditCursor`, so no PostgREST syntax can be injected.
 */
export function auditKeysetFilter(c: AuditCursor): { lt: string } | { or: string } {
  if (!c.id) return { lt: c.at };
  const at = `"${c.at}"`;
  return { or: `created_at.lt.${at},and(created_at.eq.${at},id.lt.${c.id})` };
}

/** Summarises a change set to field names only (values may contain personal data). */
export function changedFields(changes: unknown): string {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return "";
  const keys = Object.keys(changes as Record<string, unknown>).filter((k) => !["updated_at", "version"].includes(k));
  return keys.length ? `fields: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? "…" : ""}` : "";
}
