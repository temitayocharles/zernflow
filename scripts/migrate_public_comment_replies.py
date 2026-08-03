from __future__ import annotations

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "lib/comment-processor.ts",
    '''import type { Database, Json } from "@/lib/types/database";
import { executeFlow } from "@/lib/flow-engine/engine";
import { createZernioClient } from "@/lib/zernio-client";
''',
    '''import type { Database, Json } from "@/lib/types/database";
import { executeFlow } from "@/lib/flow-engine/engine";
import { dispatchPublicCommentReply } from "@/lib/social-gateway/comment-reply";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
''',
)

replace_once(
    "lib/comment-processor.ts",
    '''  comment,
  gatewayConversationId,
}: {
  supabase: SupabaseClient<Database>;
  channel: Channel;
  comment: IncomingComment;
  gatewayConversationId?: string;
}): Promise<ProcessCommentResult> {
''',
    '''  comment,
  gatewayConversationId,
  gatewayMessageId,
}: {
  supabase: SupabaseClient<Database>;
  channel: Channel;
  comment: IncomingComment;
  gatewayConversationId?: string;
  gatewayMessageId?: string;
}): Promise<ProcessCommentResult> {
''',
)

replace_once(
    "lib/comment-processor.ts",
    '''    let replySent = false;
    if (config.replyText) {
      const { data: workspace } = await supabase
        .from("workspaces")
        .select("late_api_key_encrypted")
        .eq("id", channel.workspace_id)
        .single();

      if (workspace?.late_api_key_encrypted) {
        try {
          const zernio = createZernioClient(workspace.late_api_key_encrypted);
          await zernio.comments.replyToInboxPost({
            path: { postId: comment.postId },
            body: {
              accountId: channel.late_account_id,
              message: config.replyText,
              commentId: comment.id,
            },
          });
          replySent = true;
        } catch (err) {
          console.error("Failed to post comment reply:", err);
        }
      }
    }
''',
    '''    let replySent = false;
    let replyProvider: "social_gateway" | "legacy_zernio" | null = null;
    if (config.replyText) {
      let legacy:
        | {
            apiKey: string;
            accountId: string;
            postId: string;
            commentId: string;
          }
        | undefined;

      if (!gatewayConversationId || !gatewayMessageId) {
        const { data: workspace, error: workspaceError } = await supabase
          .from("workspaces")
          .select("late_api_key_encrypted")
          .eq("id", channel.workspace_id)
          .single();
        if (workspaceError) throw new Error(workspaceError.message);
        if (workspace?.late_api_key_encrypted) {
          legacy = {
            apiKey: workspace.late_api_key_encrypted,
            accountId: channel.late_account_id,
            postId: comment.postId,
            commentId: comment.id,
          };
        }
      }

      const reply = await dispatchPublicCommentReply(
        requireSocialGatewayClient(),
        {
          text: config.replyText,
          idempotencyKey: `zernflow:comment-reply:${channel.id}:${comment.id}`,
          gatewayConversationId,
          gatewayMessageId,
          legacy,
        },
      );
      replySent = true;
      replyProvider = reply.provider;
    }
''',
)

replace_once(
    "lib/comment-processor.ts",
    '''        dmSent,
        replySent,
      } as unknown as Json,
''',
    '''        dmSent,
        replySent,
        replyProvider,
      } as unknown as Json,
''',
)

replace_once(
    "lib/social-gateway/webhook-processor.ts",
    '''    gatewayConversationId: envelope.conversation_id ?? undefined,
    comment: {
''',
    '''    gatewayConversationId: envelope.conversation_id ?? undefined,
    gatewayMessageId: envelope.message_id ?? undefined,
    comment: {
''',
)
