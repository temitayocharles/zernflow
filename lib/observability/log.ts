/**
 * Structured JSON-line logging with secret redaction. Every execution log line
 * carries correlation/workspace/task identity so a run can be followed across
 * the tick, the worker API, the Gateway and execution records.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  correlationId?: string;
  workspaceId?: string;
  taskId?: string;
  provider?: string;
  accountRef?: string;
  operation?: string;
  attempt?: number;
  status?: string;
  latencyMs?: number;
  errorClass?: string;
  retryDecision?: string;
  [key: string]: unknown;
}

const SECRET_KEY =
  /(secret|token|password|passwd|authorization|cookie|api[_-]?key|credential|storage[_-]?state|private[_-]?key|session[_-]?data|plaintext|dek)/i;
const SECRET_VALUE = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bzfw_[A-Za-z0-9_-]{16,}/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, "[REDACTED]");
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogSink = (line: string, level: LogLevel) => void;
let sink: LogSink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/** Test seam. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) });
  sink(line, level);
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};

/** Trace seam: measures a span; OpenTelemetry can wrap this later without call-site changes. */
export async function withSpan<T>(name: string, fields: LogFields, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    log("debug", `${name}.ok`, { ...fields, latencyMs: Date.now() - started });
    return result;
  } catch (error) {
    log("warn", `${name}.error`, { ...fields, latencyMs: Date.now() - started, error });
    throw error;
  }
}
