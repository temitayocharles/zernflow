import { readJson } from "@/lib/product/api";
import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import {
  parseCollaborationCommand,
  requiresOwner,
} from "@/lib/collaboration/contracts";
import { requireOperatorGatewayClient } from "@/lib/social-gateway/server";
import {
  SocialGatewayError,
  SocialGatewayConfigurationError,
} from "@/lib/social-gateway/client";
import { createServiceClient } from "@/lib/supabase/server";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = uuid((await params).id, "conversation");
    const { supabase, user, workspaceId, role } = await productContext();
    const command = parseCollaborationCommand(await readJson(request));
    if (requiresOwner(command) && role !== "owner")
      throw new ApiError(403, "Workspace owner access required");
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("id,late_conversation_id")
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .maybeSingle();
    databaseError(error);
    if (!conversation?.late_conversation_id)
      throw new ApiError(404, "Gateway-linked conversation not found");
    const gateway = requireOperatorGatewayClient(user.id);
    const service = await createServiceClient();
    const remote = conversation.late_conversation_id;
    const control =
      command.action === "takeover" || command.action === "release"
        ? await gateway.setHumanTakeover(
            remote,
            command.action === "takeover",
            command.reason,
          )
        : command.action === "escalate"
          ? await gateway.escalateConversation(remote, command.reason)
          : await gateway.assignConversation(
              remote,
              command.action === "assign_agent"
                ? { assignmentType: "agent", assigneeRef: command.agentRef }
                : command.action === "assign_self"
                  ? { assignmentType: "human", assigneeRef: user.id }
                  : { assignmentType: "unassigned" },
            );
    const audit = await service.from("product_activity").insert({
      workspace_id: workspaceId,
      entity_type: "conversations",
      entity_id: id,
      actor_id: user.id,
      action: `gateway.${command.action}`,
      changes: {
        gateway_version: control.version,
        assignment_type: control.assignment_type,
        human_takeover: control.human_takeover,
        escalated: control.escalated,
        ...("reason" in command ? { reason: command.reason } : {}),
      },
    });
    return json({
      control,
      auditRecorded: !audit.error,
      warning: audit.error
        ? "Gateway action applied, but the local audit write failed. Do not retry the action solely to repair audit."
        : null,
    });
  } catch (e) {
    if (
      e instanceof SocialGatewayError ||
      e instanceof SocialGatewayConfigurationError
    )
      return json(
        {
          error:
            "Gateway control unavailable or rejected. No local success has been assumed.",
          code: e.code,
        },
        503,
      );
    return failure(e);
  }
}
