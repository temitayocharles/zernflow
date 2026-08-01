import Zernio from "@zernio/node";

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

/**
 * Temporary compatibility adapter. It is the only module allowed to import
 * `@zernio/node`; callers depend on the provider-neutral interface above.
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

export function createSocialGatewayClient(apiKey: string): SocialGatewayClient {
  return new ZernioCompatibilityAdapter(apiKey);
}
