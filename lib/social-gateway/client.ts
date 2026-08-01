import Zernio from "@zernio/node";

export type RuntimeEnv = Record<string, string | undefined>;

export type GatewayPlatform =
  | "facebook"
  | "instagram"
  | "twitter"
  | "telegram"
  | "bluesky"
  | "reddit";

export interface GatewayResponse<T = unknown> {
  data?: T;
  error?: unknown;
  status?: number;
}

export interface GatewayAccount {
  _id?: string;
  platform?: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  [key: string]: unknown;
}

export interface GatewayWebhook {
  _id?: string;
  name?: string;
  url?: string;
  secret?: string;
  events?: string[];
}

export interface SendConversationInput {
  conversationId: string;
  accountId: string;
  message: string;
  attachmentUrl?: string;
  attachmentType?: string;
  buttons?: unknown[];
  quickReplies?: unknown[];
  template?: unknown;
  replyMarkup?: unknown;
}

export interface SocialGatewayClient {
  profiles: {
    list(): Promise<GatewayResponse<{ profiles?: Array<{ _id?: string }> }>>;
  };
  connections: {
    getConnectUrl(input: {
      platform: GatewayPlatform;
      profileId: string;
      redirectUrl: string;
    }): Promise<GatewayResponse<{ authUrl?: string }>>;
  };
  accounts: {
    list(): Promise<GatewayResponse<{ accounts?: GatewayAccount[] }>>;
    disconnect(input: { accountId: string }): Promise<GatewayResponse>;
  };
  conversations: {
    list(input: {
      accountId: string;
      limit: number;
      sortOrder: "asc" | "desc";
      cursor?: string;
    }): Promise<
      GatewayResponse<{
        data?: unknown[];
        pagination?: { hasMore?: boolean; nextCursor?: string };
      }>
    >;
    messages(input: {
      conversationId: string;
      accountId: string;
    }): Promise<GatewayResponse<{ messages?: unknown[]; data?: unknown[] }>>;
    send(input: SendConversationInput): Promise<
      GatewayResponse<{ data?: { messageId?: string }; messageId?: string }>
    >;
  };
  comments: {
    replyPublic(input: {
      accountId: string;
      postId: string;
      commentId: string;
      message: string;
    }): Promise<GatewayResponse>;
    replyPrivate(input: {
      accountId: string;
      postId: string;
      commentId: string;
      message: string;
    }): Promise<GatewayResponse>;
  };
  webhooks: {
    list(): Promise<GatewayResponse<{ webhooks?: GatewayWebhook[] }>>;
    create(input: {
      name: string;
      url: string;
      secret: string;
      events: string[];
    }): Promise<GatewayResponse>;
    update(input: {
      id: string;
      name: string;
      url: string;
      secret: string;
      events: string[];
    }): Promise<GatewayResponse>;
  };
}

type SdkResponse<T = unknown> = {
  data?: T;
  error?: unknown;
  response?: { status?: number };
};

function normalize<T = unknown>(response: unknown): GatewayResponse<T> {
  const typed = response as SdkResponse<T>;
  return {
    data: typed.data,
    error: typed.error,
    status: typed.response?.status,
  };
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/, "");
  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SOCIAL_GATEWAY_BASE_URL must use HTTP or HTTPS');
  }
  return normalized;
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  return text ? { message: text.slice(0, 2048) } : undefined;
}

export class AgentSocialGatewayHttpAdapter implements SocialGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(input: { baseUrl: string; apiKey: string }) {
    this.baseUrl = normalizeBaseUrl(input.baseUrl);
    this.apiKey = input.apiKey.trim();
    if (!this.apiKey) throw new Error('SOCIAL_GATEWAY_API_KEY is required');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<GatewayResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        ...(init?.headers || {}),
      },
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      return { error: payload, status: response.status };
    }
    return { data: payload as T, status: response.status };
  }

  readonly profiles = {
    list: () => this.request<{ profiles?: Array<{ _id?: string }> }>('/v1/profiles'),
  };

  readonly connections = {
    getConnectUrl: (input: {
      platform: GatewayPlatform;
      profileId: string;
      redirectUrl: string;
    }) =>
      this.request<{ authUrl?: string }>(
        `/v1/connections/${encodeURIComponent(input.platform)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            profile_id: input.profileId,
            redirect_url: input.redirectUrl,
          }),
        },
      ),
  };

  readonly accounts = {
    list: () => this.request<{ accounts?: GatewayAccount[] }>('/v1/accounts'),
    disconnect: (input: { accountId: string }) =>
      this.request(`/v1/accounts/${encodeURIComponent(input.accountId)}`, {
        method: 'DELETE',
      }),
  };

  readonly conversations = {
    list: (input: {
      accountId: string;
      limit: number;
      sortOrder: 'asc' | 'desc';
      cursor?: string;
    }) => {
      const query = new URLSearchParams({
        limit: String(input.limit),
        sort_order: input.sortOrder,
      });
      if (input.cursor) query.set('cursor', input.cursor);
      return this.request<{
        data?: unknown[];
        pagination?: { hasMore?: boolean; nextCursor?: string };
      }>(
        `/v1/accounts/${encodeURIComponent(input.accountId)}/conversations?${query.toString()}`,
      );
    },
    messages: (input: { conversationId: string; accountId: string }) =>
      this.request<{ messages?: unknown[]; data?: unknown[] }>(
        `/v1/accounts/${encodeURIComponent(input.accountId)}/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      ),
    send: (input: SendConversationInput) =>
      this.request<{ data?: { messageId?: string }; messageId?: string }>(
        `/v1/accounts/${encodeURIComponent(input.accountId)}/conversations/${encodeURIComponent(input.conversationId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            message: input.message,
            attachment_url: input.attachmentUrl,
            attachment_type: input.attachmentType,
            buttons: input.buttons,
            quick_replies: input.quickReplies,
            template: input.template,
            reply_markup: input.replyMarkup,
          }),
        },
      ),
  };

  readonly comments = {
    replyPublic: (input: {
      accountId: string;
      postId: string;
      commentId: string;
      message: string;
    }) =>
      this.request(
        `/v1/accounts/${encodeURIComponent(input.accountId)}/comments/${encodeURIComponent(input.commentId)}/replies`,
        {
          method: 'POST',
          body: JSON.stringify({ post_id: input.postId, message: input.message }),
        },
      ),
    replyPrivate: (input: {
      accountId: string;
      postId: string;
      commentId: string;
      message: string;
    }) =>
      this.request(
        `/v1/accounts/${encodeURIComponent(input.accountId)}/comments/${encodeURIComponent(input.commentId)}/private-replies`,
        {
          method: 'POST',
          body: JSON.stringify({ post_id: input.postId, message: input.message }),
        },
      ),
  };

  readonly webhooks = {
    list: () => this.request<{ webhooks?: GatewayWebhook[] }>('/v1/webhooks'),
    create: (input: {
      name: string;
      url: string;
      secret: string;
      events: string[];
    }) => this.request('/v1/webhooks', { method: 'POST', body: JSON.stringify(input) }),
    update: (input: {
      id: string;
      name: string;
      url: string;
      secret: string;
      events: string[];
    }) =>
      this.request(`/v1/webhooks/${encodeURIComponent(input.id)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
  };
}

/**
 * Temporary hosted compatibility adapter. It is the only module allowed to
 * import `@zernio/node`; callers depend on the provider-neutral interface.
 */
export class ZernioCompatibilityAdapter implements SocialGatewayClient {
  private readonly sdk: Zernio;

  constructor(apiKey: string) {
    this.sdk = new Zernio({ apiKey });
  }

  readonly profiles = {
    list: async () =>
      normalize<{ profiles?: Array<{ _id?: string }> }>(
        await this.sdk.profiles.listProfiles()
      ),
  };

  readonly connections = {
    getConnectUrl: async (input: {
      platform: GatewayPlatform;
      profileId: string;
      redirectUrl: string;
    }) =>
      normalize<{ authUrl?: string }>(
        await this.sdk.connect.getConnectUrl({
          path: { platform: input.platform },
          query: {
            profileId: input.profileId,
            redirect_url: input.redirectUrl,
          },
        })
      ),
  };

  readonly accounts = {
    list: async () =>
      normalize<{ accounts?: GatewayAccount[] }>(
        await this.sdk.accounts.listAccounts()
      ),
    disconnect: async (input: { accountId: string }) =>
      normalize(
        await this.sdk.accounts.deleteAccount({
          path: { accountId: input.accountId },
        })
      ),
  };

  readonly conversations = {
    list: async (input: {
      accountId: string;
      limit: number;
      sortOrder: "asc" | "desc";
      cursor?: string;
    }) =>
      normalize<{
        data?: unknown[];
        pagination?: { hasMore?: boolean; nextCursor?: string };
      }>(
        await this.sdk.messages.listInboxConversations({
          query: input,
        })
      ),
    messages: async (input: { conversationId: string; accountId: string }) =>
      normalize<{ messages?: unknown[]; data?: unknown[] }>(
        await this.sdk.messages.getInboxConversationMessages({
          path: { conversationId: input.conversationId },
          query: { accountId: input.accountId },
        })
      ),
    send: async (input: SendConversationInput) => {
      const {
        conversationId,
        accountId,
        message,
        attachmentUrl,
        attachmentType,
        buttons,
        quickReplies,
        template,
        replyMarkup,
      } = input;
      const body: Record<string, unknown> = { accountId, message };
      if (attachmentUrl !== undefined) body.attachmentUrl = attachmentUrl;
      if (attachmentType !== undefined) body.attachmentType = attachmentType;
      if (buttons !== undefined) body.buttons = buttons;
      if (quickReplies !== undefined) body.quickReplies = quickReplies;
      if (template !== undefined) body.template = template;
      if (replyMarkup !== undefined) body.replyMarkup = replyMarkup;

      return normalize<{ data?: { messageId?: string }; messageId?: string }>(
        await this.sdk.messages.sendInboxMessage({
          path: { conversationId },
          body: body as never,
        })
      );
    },
  };

  readonly comments = {
    replyPublic: async (input: {
      accountId: string;
      postId: string;
      commentId: string;
      message: string;
    }) =>
      normalize(
        await this.sdk.comments.replyToInboxPost({
          path: { postId: input.postId },
          body: {
            accountId: input.accountId,
            commentId: input.commentId,
            message: input.message,
          },
        })
      ),
    replyPrivate: async (input: {
      accountId: string;
      postId: string;
      commentId: string;
      message: string;
    }) =>
      normalize(
        await this.sdk.comments.sendPrivateReplyToComment({
          path: { postId: input.postId, commentId: input.commentId },
          body: { accountId: input.accountId, message: input.message },
        })
      ),
  };

  readonly webhooks = {
    list: async () =>
      normalize<{ webhooks?: GatewayWebhook[] }>(
        await this.sdk.webhooks.getWebhookSettings()
      ),
    create: async (input: {
      name: string;
      url: string;
      secret: string;
      events: string[];
    }) =>
      normalize(
        await this.sdk.webhooks.createWebhookSettings({
          body: input,
        })
      ),
    update: async (input: {
      id: string;
      name: string;
      url: string;
      secret: string;
      events: string[];
    }) =>
      normalize(
        await this.sdk.webhooks.updateWebhookSettings({
          body: {
            _id: input.id,
            name: input.name,
            url: input.url,
            secret: input.secret,
            events: input.events,
          },
        })
      ),
  };
}

export type SocialGatewayDriver = 'agent' | 'zernio';

export interface SocialGatewayRuntimeStatus {
  driver: SocialGatewayDriver;
  configured: boolean;
  endpoint?: string;
}

export function getSocialGatewayRuntimeStatus(
  env: RuntimeEnv = process.env,
): SocialGatewayRuntimeStatus {
  const driver = (env.SOCIAL_GATEWAY_DRIVER || 'agent').trim().toLowerCase();
  if (driver === 'zernio') {
    return {
      driver: 'zernio',
      configured: Boolean(env.ZERNIO_API_KEY?.trim()),
    };
  }
  return {
    driver: 'agent',
    configured: Boolean(
      env.SOCIAL_GATEWAY_BASE_URL?.trim() && env.SOCIAL_GATEWAY_API_KEY?.trim(),
    ),
    endpoint: env.SOCIAL_GATEWAY_BASE_URL?.trim(),
  };
}

export function createSocialGatewayClient(
  env: RuntimeEnv = process.env,
): SocialGatewayClient {
  const status = getSocialGatewayRuntimeStatus(env);
  if (status.driver === 'zernio') {
    const apiKey = env.ZERNIO_API_KEY?.trim();
    if (!apiKey) throw new Error('ZERNIO_API_KEY is not configured');
    return new ZernioCompatibilityAdapter(apiKey);
  }

  const baseUrl = env.SOCIAL_GATEWAY_BASE_URL?.trim();
  const apiKey = env.SOCIAL_GATEWAY_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      'SOCIAL_GATEWAY_BASE_URL and SOCIAL_GATEWAY_API_KEY must be injected by the runtime secret manager',
    );
  }
  return new AgentSocialGatewayHttpAdapter({ baseUrl, apiKey });
}
