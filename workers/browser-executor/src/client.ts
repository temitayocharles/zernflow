/**
 * Minimal worker-API client. The bearer token only ever goes to ZERNFLOW_URL:
 * redirects are refused, plain http is refused except for localhost, and
 * artifact bytes go to the presigned storage URL without the token.
 */
export interface ClaimedTask {
  id: string;
  kind: string;
  input: Record<string, unknown>;
  attempt: number;
  executionMode: string;
  correlationId: string | null;
}

export interface LeasedSession {
  session: { id: string; platform: string; label: string; profileKey: string; allowedHosts: string[] };
  storageState: unknown;
}

export interface ExecutionSummary {
  provider: string;
  operation: string;
  latencyMs: number;
  artifactIds: string[];
  resultMeta: Record<string, unknown>;
}

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function validateBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ZERNFLOW_URL must be an absolute URL");
  }
  if (url.username || url.password) throw new Error("ZERNFLOW_URL must not contain credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error("ZERNFLOW_URL must use https (http is allowed only for localhost)");
  }
  return url;
}

export class WorkerClient {
  private readonly base: URL;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; token: string; fetch?: FetchLike; timeoutMs?: number }) {
    if (!/^zfw_[A-Za-z0-9_-]{20,}$/.test(opts.token)) throw new Error("ZERNFLOW_WORKER_TOKEN is missing or malformed");
    this.base = validateBaseUrl(opts.baseUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private readonly token: string;

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const url = new URL(`/api/worker/v1/${path}`, this.base).toString();
    const res = await this.fetchImpl(url, {
      method,
      redirect: "error",
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 204) return { status: 204, data: null };
    const data = (await res.json().catch(() => null)) as (T & { code?: string; error?: string }) | null;
    if (!res.ok) throw new WorkerApiError(res.status, data?.code ?? "http_error", data?.error ?? `Worker API returned ${res.status}`);
    return { status: res.status, data };
  }

  async claim(body: { modes: string[]; capabilities: { adapters: string[] }; version: string }): Promise<ClaimedTask | null> {
    const r = await this.call<{ task: ClaimedTask }>("POST", "claim", body);
    return r.data?.task ?? null;
  }

  async heartbeat(taskId: string, leaseSeconds = 300): Promise<void> {
    await this.call("POST", `tasks/${encodeURIComponent(taskId)}/heartbeat`, { leaseSeconds });
  }

  async session(taskId: string): Promise<LeasedSession> {
    const r = await this.call<LeasedSession>("GET", `tasks/${encodeURIComponent(taskId)}/session`);
    if (!r.data) throw new WorkerApiError(502, "empty_response", "Session response was empty");
    return r.data;
  }

  async reportSession(taskId: string, body: { state: string; reason: string; storageState?: string }): Promise<void> {
    await this.call("POST", `tasks/${encodeURIComponent(taskId)}/session`, body);
  }

  /** Presign → PUT (no bearer token) → verify. Returns the artifact id once verified. */
  async uploadArtifact(taskId: string, file: { kind: "screenshot"; fileName: string; contentType: string; bytes: Uint8Array; sha256: string }): Promise<string> {
    const presign = await this.call<{ artifactId: string; upload: { url: string; method: "PUT"; headers: Record<string, string> } }>(
      "POST",
      `tasks/${encodeURIComponent(taskId)}/artifacts`,
      { kind: file.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.bytes.byteLength, sha256: file.sha256 },
    );
    const { artifactId, upload } = presign.data!;
    const put = await this.fetchImpl(upload.url, { method: "PUT", headers: upload.headers, body: file.bytes as unknown as BodyInit, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!put.ok) throw new WorkerApiError(put.status, "upload_failed", `Artifact upload failed (${put.status})`);
    await this.call("POST", `tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/complete`);
    return artifactId;
  }

  async complete(taskId: string, body: { result: Record<string, unknown>; execution: ExecutionSummary }): Promise<void> {
    await this.call("POST", `tasks/${encodeURIComponent(taskId)}/complete`, body);
  }

  async fail(taskId: string, body: { error: { class: string; message: string; retryAfterMs?: number }; execution?: ExecutionSummary }): Promise<void> {
    await this.call("POST", `tasks/${encodeURIComponent(taskId)}/fail`, body);
  }
}
