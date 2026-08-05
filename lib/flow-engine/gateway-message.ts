import { createHash } from "node:crypto";
import type { Platform } from "@/lib/types/database";
import type { ReplyInput } from "@/lib/social-gateway/types";
import { adaptMessage } from "./platform-adapter";
import type { SendMessageNodeData } from "./types";

type FlowMessage = SendMessageNodeData["messages"][number] & {
  mediaUrl?: string;
  mediaType?: string;
};

const RICH_META_PLATFORMS = new Set<Platform>([
  "facebook",
  "instagram",
  "whatsapp",
]);

function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    return variables[key] ?? "";
  });
}

function attachmentType(value: string | undefined): "image" | "video" | "audio" | "file" {
  if (value === "video" || value === "audio" || value === "file") return value;
  return "image";
}

export function flowReplyIdempotencyKey(input: {
  workspaceId: string;
  flowId: string;
  sessionId: string;
  nodeId: string;
  messageIndex: number;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        input.workspaceId,
        input.flowId,
        input.sessionId,
        input.nodeId,
        String(input.messageIndex),
      ].join(":"),
    )
    .digest("hex");
  return `zernflow:flow:${digest.slice(0, 48)}`;
}

export function buildGatewayFlowReply(input: {
  message: FlowMessage;
  platform: Platform;
  variables: Record<string, string>;
  workspaceId: string;
  flowId: string;
  sessionId: string;
  nodeId: string;
  messageIndex: number;
}): ReplyInput {
  const adapted = adaptMessage(input.message, input.platform);
  const mediaUrl = input.message.mediaUrl ?? input.message.imageUrl;
  const mediaType = input.message.mediaType ?? (input.message.imageUrl ? "image" : undefined);
  const text = interpolate(adapted.text, input.variables).trim();

  const reply: ReplyInput = {
    ...(text ? { text } : {}),
    ...(mediaUrl
      ? {
          attachments: [
            {
              type: attachmentType(mediaType),
              url: interpolate(mediaUrl, input.variables),
            },
          ],
        }
      : {}),
    idempotencyKey: flowReplyIdempotencyKey(input),
  };

  if (RICH_META_PLATFORMS.has(input.platform)) {
    if (adapted.template?.elements.length) {
      reply.presentation = {
        carousel: adapted.template.elements.map((element) => ({
          title: interpolate(element.title, input.variables),
          ...(element.subtitle
            ? { subtitle: interpolate(element.subtitle, input.variables) }
            : {}),
          ...(element.imageUrl
            ? { imageUrl: interpolate(element.imageUrl, input.variables) }
            : {}),
          buttons: (element.buttons ?? []).map((button) => ({
            title: interpolate(button.title, input.variables),
            type: button.type,
            ...(button.payload
              ? { payload: interpolate(button.payload, input.variables) }
              : {}),
            ...(button.url ? { url: interpolate(button.url, input.variables) } : {}),
          })),
        })),
      };
    } else if (adapted.buttons?.length || adapted.quickReplies?.length) {
      reply.presentation = {
        ...(adapted.buttons?.length
          ? {
              buttons: adapted.buttons.map((button) => ({
                title: interpolate(button.title, input.variables),
                type: button.type,
                ...(button.payload
                  ? { payload: interpolate(button.payload, input.variables) }
                  : {}),
                ...(button.url ? { url: interpolate(button.url, input.variables) } : {}),
              })),
            }
          : {}),
        ...(adapted.quickReplies?.length
          ? {
              quickReplies: adapted.quickReplies.map((quickReply) => ({
                title: interpolate(quickReply.title, input.variables),
                payload: interpolate(quickReply.payload, input.variables),
              })),
            }
          : {}),
      };
    }
  } else if (input.platform === "telegram") {
    if (input.message.buttons?.length || input.message.quickReplies?.length) {
      reply.presentation = {
        ...(input.message.buttons?.length
          ? {
              buttons: input.message.buttons.map((button) => ({
                title: interpolate(button.title, input.variables),
                type: button.type,
                ...(button.payload
                  ? { payload: interpolate(button.payload, input.variables) }
                  : {}),
                ...(button.url ? { url: interpolate(button.url, input.variables) } : {}),
              })),
            }
          : {}),
        ...(input.message.quickReplies?.length
          ? {
              quickReplies: input.message.quickReplies.map((quickReply) => ({
                title: interpolate(quickReply.title, input.variables),
                payload: interpolate(quickReply.payload, input.variables),
              })),
            }
          : {}),
      };
    }
  }

  return reply;
}
