import type { ReplyInput } from "./types";

export interface GatewayReplyPayload extends Record<string, unknown> {
  text: string | null;
  attachments: Array<{
    type: string;
    url: string;
    mime_type?: string;
    name?: string;
  }>;
  presentation: {
    quick_replies: Array<{ title: string; payload: string }>;
    buttons: Array<{
      title: string;
      type: string;
      payload?: string;
      url?: string;
    }>;
    carousel: Array<{
      title: string;
      subtitle?: string;
      image_url?: string;
      buttons: Array<{
        title: string;
        type: string;
        payload?: string;
        url?: string;
      }>;
    }>;
  } | null;
  idempotency_key: string;
  reply_to_message_id: string | null;
}

export function serializeReplyInput(input: ReplyInput): GatewayReplyPayload {
  const quickReplies = input.presentation?.quickReplies ?? [];
  const buttons = input.presentation?.buttons ?? [];
  const carousel = input.presentation?.carousel ?? [];
  const hasPresentation =
    quickReplies.length > 0 || buttons.length > 0 || carousel.length > 0;

  return {
    text: input.text?.trim() || null,
    attachments: (input.attachments ?? []).map((attachment) => ({
      type: attachment.type,
      url: attachment.url,
      ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
      ...(attachment.name ? { name: attachment.name } : {}),
    })),
    presentation: hasPresentation
      ? {
          quick_replies: quickReplies.map((item) => ({
            title: item.title,
            payload: item.payload,
          })),
          buttons: buttons.map((button) => ({
            title: button.title,
            type: button.type,
            ...(button.payload ? { payload: button.payload } : {}),
            ...(button.url ? { url: button.url } : {}),
          })),
          carousel: carousel.map((element) => ({
            title: element.title,
            ...(element.subtitle ? { subtitle: element.subtitle } : {}),
            ...(element.imageUrl ? { image_url: element.imageUrl } : {}),
            buttons: (element.buttons ?? []).map((button) => ({
              title: button.title,
              type: button.type,
              ...(button.payload ? { payload: button.payload } : {}),
              ...(button.url ? { url: button.url } : {}),
            })),
          })),
        }
      : null,
    idempotency_key: input.idempotencyKey,
    reply_to_message_id: input.replyToMessageId ?? null,
  };
}
