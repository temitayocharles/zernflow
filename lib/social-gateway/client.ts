import { serializeReplyInput } from "./reply";
import type {
  AssignmentInput,
  DraftReplyInput,
  GatewayAccountList,
  GatewayActionRequest,
  GatewayConversationControl,
  GatewayConversationDetail,
  GatewayConversationPage,
  GatewayOperation,
  GetConversationInput,
  ListConversationsInput,
  ReplyInput,
  SocialGatewayClient,
} from "./types";

type GatewayAuth = "operator" | "admin" | "agent";
type FetchLike = typeof fetch;

export interface HttpSocialGatewayClientOptions {
  baseUrl: string;
  operatorApiKey: string;
  adminApiKey?: string;
  agentCredential?: string;
  actorRef?: string;
  workspaceRef?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  production?: boolean;
}

interface GatewayErrorEnvelope {
  detail?: {
    code?: unknown;
    message?: unknown;
  };
}

export class SocialGatewayError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { status?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SocialGatewayError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export class SocialGatewayConfigurationError extends SocialGatewayError {
  constructor(message: string) {
    super("social_gateway_not_configured", message);
    this.name = "SocialGatewayConfigurationError";
  }
}

function validateBaseUrl(rawValue: string, production: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new SocialGatewayConfigurationError(
      "SOCIAL_GATEWAY_BASE_URL must be an absolute HTTP(S) URL",
    );
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new SocialGatewayConfigurationError(
      "SOCIAL_GATEWAY_BASE_URL must use HTTP or HTTPS",
    );
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new SocialGatewayConfigurationError(
      "SOCIAL_GATEWAY_BASE_URL cannot contain credentials or a fragment",
    );
  }

  const isLoopback = new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname);
  if (production && parsed.protocol !== "https:" && !isLoopback) {
    throw new SocialGatewayConfigurationError(
      "SOCIAL_GATEWAY_BASE_URL must use HTTPS in production",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

function normalizeCredential(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length < 24) {
    throw new SocialGatewayConfigurationError(`${name} must contain at least 24 characters`);
  }
  return normalized;
}

function appendQuery(url: URL, values: Record<string, string | number | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  const fallback = {
    code: `social_gateway_http_${response.status}`,
    message: "Social gateway request failed",
  };

  try {
    const body = (await response.json()) as GatewayErrorEnvelope;
    const code = typeof body.detail?.code === "string" ? body.detail.code : fallback.code;
    const message =
      typeof body.detail?.message === "string" ? body.detail.message : fallback.message;
    return { code, message };
  } catch {
    return fallback;
  }
}

export class HttpSocialGatewayClient implements SocialGatewayClient {
  private readonly baseUrl: URL;
  private readonly operatorApiKey: string;
  private readonly adminApiKey?: string;
  private readonly agentCredential?: string;
  private readonly actorRef: string;
  private readonly workspaceRef: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpSocialGatewayClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl, options.production ?? false);
    this.operatorApiKey = normalizeCredential(options.operatorApiKey, "operatorApiKey");
    this.adminApiKey = options.adminApiKey?.trim() || undefined;
    this.agentCredential = options.agentCredential?.trim() || undefined;
    this.actorRef = options.actorRef?.trim() || "zernflow";
    this.workspaceRef = options.workspaceRef?.trim() || "default";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new SocialGatewayConfigurationError("timeoutMs must be between 100 and 60000");
    }
    if (this.adminApiKey) {
      normalizeCredential(this.adminApiKey, "adminApiKey");
    }
    if (this.agentCredential) {
      normalizeCredential(this.agentCredential, "agentCredential");
    }
  }

  async listAccounts(): Promise<GatewayAccountList> {
    return this.request<GatewayAccountList>("/v1/accounts", { auth: "operator" });
  }

  async listConversations(
    input: ListConversationsInput = {},
  ): Promise<GatewayConversationPage> {
    const url = this.url("/v1/conversations");
    appendQuery(url, {
      limit: input.limit,
      cursor: input.cursor,
      provider: input.provider,
      kind: input.kind,
    });
    return this.requestUrl<GatewayConversationPage>(url, { auth: "operator" });
  }

  async getConversation(
    conversationId: string,
    input: GetConversationInput = {},
  ): Promise<GatewayConversationDetail> {
    const url = this.url(`/v1/conversations/${encodeURIComponent(conversationId)}`);
    appendQuery(url, {
      message_limit: input.messageLimit,
      message_cursor: input.messageCursor,
    });
    return this.requestUrl<GatewayConversationDetail>(url, { auth: "operator" });
  }

  async replyToConversation(
    conversationId: string,
    input: ReplyInput,
  ): Promise<GatewayOperation> {
    return this.request<GatewayOperation>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/replies`,
      {
        auth: "operator",
        method: "POST",
        body: serializeReplyInput(input),
      },
    );
  }

  async createDraft(
    conversationId: string,
    input: DraftReplyInput,
  ): Promise<GatewayActionRequest> {
    return this.request<GatewayActionRequest>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/drafts`,
      {
        auth: "agent",
        method: "POST",
        body: {
          text: input.text,
          idempotency_key: input.idempotencyKey,
          reply_to_message_id: input.replyToMessageId ?? null,
          risk_level: input.riskLevel ?? "medium",
        },
      },
    );
  }

  async assignConversation(
    conversationId: string,
    input: AssignmentInput,
  ): Promise<GatewayConversationControl> {
    return this.request<GatewayConversationControl>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/assignment`,
      {
        auth: "operator",
        method: "POST",
        body: {
          assignment_type: input.assignmentType,
          assignee_ref: input.assigneeRef ?? null,
        },
      },
    );
  }

  async escalateConversation(
    conversationId: string,
    reason: string,
  ): Promise<GatewayConversationControl> {
    return this.request<GatewayConversationControl>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/escalate`,
      { auth: "operator", method: "POST", body: { reason } },
    );
  }

  async setHumanTakeover(
    conversationId: string,
    enabled: boolean,
    reason?: string,
  ): Promise<GatewayConversationControl> {
    return this.request<GatewayConversationControl>(
      `/v1/admin/conversations/${encodeURIComponent(conversationId)}/human-takeover`,
      {
        auth: "admin",
        method: "POST",
        body: { enabled, reason: reason ?? null },
      },
    );
  }

  async approveAction(requestId: string, reason?: string): Promise<GatewayActionRequest> {
    return this.reviewAction(requestId, "approve", reason);
  }

  async rejectAction(requestId: string, reason?: string): Promise<GatewayActionRequest> {
    return this.reviewAction(requestId, "reject", reason);
  }

  async getOperation(operationId: string): Promise<GatewayOperation> {
    return this.request<GatewayOperation>(
      `/v1/operations/${encodeURIComponent(operationId)}`,
      { auth: "operator" },
    );
  }

  private async reviewAction(
    requestId: string,
    action: "approve" | "reject",
    reason?: string,
  ): Promise<GatewayActionRequest> {
    return this.request<GatewayActionRequest>(
      `/v1/admin/agent-action-requests/${encodeURIComponent(requestId)}/${action}`,
      { auth: "admin", method: "POST", body: { reason: reason ?? null } },
    );
  }

  private url(path: string): URL {
    return new URL(`${this.baseUrl.pathname}${path}`.replace(/\/+/g, "/"), this.baseUrl);
  }

  private async request<T>(
    path: string,
    options: {
      auth: GatewayAuth;
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    return this.requestUrl<T>(this.url(path), options);
  }

  private async requestUrl<T>(
    url: URL,
    options: {
      auth: GatewayAuth;
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: this.headers(options.auth, options.body !== undefined),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await readError(response);
        throw new SocialGatewayError(error.code, error.message, {
          status: response.status,
          retryable:
            response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
        });
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof SocialGatewayError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SocialGatewayError(
          "social_gateway_timeout",
          "Social gateway request timed out",
          { retryable: true, cause: error },
        );
      }
      throw new SocialGatewayError(
        "social_gateway_unavailable",
        "Social gateway is unavailable",
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(auth: GatewayAuth, hasBody: boolean): Headers {
    const headers = new Headers({
      Accept: "application/json",
      "X-Workspace-Ref": this.workspaceRef,
    });
    if (hasBody) {
      headers.set("Content-Type", "application/json");
    }

    if (auth === "operator") {
      headers.set("X-API-Key", this.operatorApiKey);
      headers.set("X-Actor-Ref", this.actorRef);
      return headers;
    }
    if (auth === "admin") {
      if (!this.adminApiKey) {
        throw new SocialGatewayConfigurationError(
          "SOCIAL_GATEWAY_ADMIN_API_KEY is required for administrator actions",
        );
      }
      headers.set("X-Admin-API-Key", this.adminApiKey);
      headers.set("X-Admin-Actor", this.actorRef);
      return headers;
    }
    if (!this.agentCredential) {
      throw new SocialGatewayConfigurationError(
        "SOCIAL_GATEWAY_AGENT_CREDENTIAL is required for agent actions",
      );
    }
    headers.set("Authorization", `Bearer ${this.agentCredential}`);
    return headers;
  }
}
