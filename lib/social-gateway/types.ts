export type GatewayProvider = "meta" | "telegram" | "generic";
export type GatewayAccountPlatform =
  | "facebook"
  | "instagram"
  | "telegram"
  | "generic"
  | "twitter"
  | "bluesky"
  | "reddit";
export type GatewayAccountStatus =
  | "pending"
  | "active"
  | "degraded"
  | "disconnected"
  | "error";
export type GatewayConversationKind = "direct_message" | "comment_thread";
export type GatewayMessageKind = "message" | "comment" | "reply";
export type GatewayMessageDirection = "inbound" | "outbound";
export type GatewayOperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";
export type GatewayRiskLevel = "low" | "medium" | "high";
export type GatewayAssignmentType = "unassigned" | "agent" | "human";
export type GatewayReplyAttachmentType = "image" | "video" | "audio" | "file";
export type GatewayReplyButtonType = "postback" | "url";

export interface GatewayAccount {
  _id: string;
  provider: string;
  platform: GatewayAccountPlatform;
  username: string | null;
  displayName: string | null;
  profilePicture: string | null;
  external_account_ref: string;
  status: GatewayAccountStatus;
  capabilities: Record<string, boolean>;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayAccountList {
  accounts: GatewayAccount[];
}

export interface GatewayProviderReadiness {
  provider: string;
  configured: boolean;
  application: string | null;
  platforms: GatewayAccountPlatform[];
}

export interface GatewayConnectionInput {
  profileId: string;
  redirectUrl: string;
}

export interface GatewayConnectionResponse {
  authUrl: string;
  session_id: string;
  expires_at: string;
}

export interface GatewayAttachment {
  type: string;
  external_id?: string | null;
  id?: string | null;
  url?: string | null;
  mime_type?: string | null;
  name?: string | null;
}

export interface GatewayParticipant {
  id: string;
  external_participant_ref: string;
  display_name: string | null;
  metadata: Record<string, unknown>;
}

export interface GatewayMessage {
  id: string;
  kind: GatewayMessageKind;
  direction: GatewayMessageDirection;
  external_message_ref: string | null;
  parent_message_id: string | null;
  external_parent_message_ref: string | null;
  sender_participant_id: string | null;
  text: string | null;
  attachments: GatewayAttachment[];
  occurred_at: string;
  delivery_state: string;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export interface GatewayConversationSummary {
  id: string;
  provider: GatewayProvider;
  provider_account_ref: string;
  kind: GatewayConversationKind;
  external_thread_ref: string;
  subject_ref: string | null;
  last_message_at: string;
  participant_count: number;
  latest_message_text: string | null;
  latest_message_kind: GatewayMessageKind | null;
  latest_message_direction: GatewayMessageDirection | null;
}

export interface GatewayConversationPage {
  items: GatewayConversationSummary[];
  next_cursor: string | null;
}

export interface GatewayConversationDetail {
  conversation: GatewayConversationSummary;
  participants: GatewayParticipant[];
  messages: GatewayMessage[];
  next_message_cursor: string | null;
}

export interface GatewayOperation {
  id: string;
  type: string;
  idempotency_key: string;
  conversation_id: string | null;
  message_id: string | null;
  reply_to_message_id: string | null;
  integration_reference: string | null;
  scheduled_at: string | null;
  timezone: string | null;
  status: GatewayOperationStatus;
  reconciliation_status: "not_required" | "required" | "resolved";
  attempt_count: number;
  max_attempts: number;
  retryable: boolean;
  external_reference: string | null;
  error_code: string | null;
  error_message: string | null;
  next_attempt_at: string | null;
  reconciled_at: string | null;
  dead_lettered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayActionRequest {
  id: string;
  conversation_id: string;
  requested_by_agent_id: string;
  workspace_ref: string;
  action: string;
  text: string;
  reply_to_message_id: string | null;
  risk_level: GatewayRiskLevel;
  status: "pending" | "approved" | "rejected" | "dispatched" | "cancelled";
  idempotency_key: string;
  operation_id: string | null;
  reviewed_by_type: string | null;
  reviewed_by_ref: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
}

export interface GatewayConversationControl {
  conversation_id: string;
  assignment_type: GatewayAssignmentType;
  assignee_ref: string | null;
  human_takeover: boolean;
  escalated: boolean;
  escalation_reason: string | null;
  updated_by_type: string;
  updated_by_ref: string;
  version: number;
  updated_at: string;
}

export interface ListConversationsInput {
  limit?: number;
  cursor?: string;
  provider?: GatewayProvider;
  kind?: GatewayConversationKind;
}

export interface GetConversationInput {
  messageLimit?: number;
  messageCursor?: string;
}

export interface GatewayReplyAttachmentInput {
  type: GatewayReplyAttachmentType;
  url: string;
  mimeType?: string;
  name?: string;
}

export interface GatewayReplyButtonInput {
  title: string;
  type: GatewayReplyButtonType;
  payload?: string;
  url?: string;
}

export interface GatewayReplyQuickReplyInput {
  title: string;
  payload: string;
}

export interface GatewayReplyCarouselElementInput {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: GatewayReplyButtonInput[];
}

export interface GatewayReplyPresentationInput {
  quickReplies?: GatewayReplyQuickReplyInput[];
  buttons?: GatewayReplyButtonInput[];
  carousel?: GatewayReplyCarouselElementInput[];
}

export interface ReplyInput {
  text?: string;
  attachments?: GatewayReplyAttachmentInput[];
  presentation?: GatewayReplyPresentationInput;
  deliveryMode?: "conversation" | "private_comment_reply";
  idempotencyKey: string;
  replyToMessageId?: string;
}

export interface DraftReplyInput {
  text: string;
  idempotencyKey: string;
  replyToMessageId?: string;
  riskLevel?: GatewayRiskLevel;
}

export interface AssignmentInput {
  assignmentType: GatewayAssignmentType;
  assigneeRef?: string;
}

export interface SocialGatewayClient {
  getProviderReadiness(provider: "meta"): Promise<GatewayProviderReadiness>;
  startConnection(
    platform: "facebook" | "instagram",
    input: GatewayConnectionInput,
  ): Promise<GatewayConnectionResponse>;
  listAccounts(): Promise<GatewayAccountList>;
  listConversations(input?: ListConversationsInput): Promise<GatewayConversationPage>;
  getConversation(
    conversationId: string,
    input?: GetConversationInput,
  ): Promise<GatewayConversationDetail>;
  replyToConversation(conversationId: string, input: ReplyInput): Promise<GatewayOperation>;
  createDraft(conversationId: string, input: DraftReplyInput): Promise<GatewayActionRequest>;
  assignConversation(
    conversationId: string,
    input: AssignmentInput,
  ): Promise<GatewayConversationControl>;
  escalateConversation(conversationId: string, reason: string): Promise<GatewayConversationControl>;
  setHumanTakeover(
    conversationId: string,
    enabled: boolean,
    reason?: string,
  ): Promise<GatewayConversationControl>;
  approveAction(requestId: string, reason?: string): Promise<GatewayActionRequest>;
  rejectAction(requestId: string, reason?: string): Promise<GatewayActionRequest>;
  getOperation(operationId: string): Promise<GatewayOperation>;
  retryOperation(operationId: string): Promise<GatewayOperation>;
}
