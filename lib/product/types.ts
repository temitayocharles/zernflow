import type { Json } from "@/lib/types/database";
export interface ProductRecord { id: string; workspace_id: string; version: number; created_at: string; updated_at: string }
export interface Company extends ProductRecord { name: string; domain: string; description: string; owner_id: string | null; lifecycle: string; source: string }
export interface CustomerProfile extends ProductRecord { contact_id: string; company_id: string | null; owner_id: string | null; lifecycle: string; source: string; lead_score: number }
export interface Deal extends ProductRecord { name: string; description: string; company_id: string | null; contact_id: string | null; owner_id: string | null; stage: string; value_minor: number; currency: string; expected_close_at: string | null; closed_at: string | null }
export interface WorkQueue extends ProductRecord { name:string;description:string }
export interface WorkItem extends ProductRecord { reference:number;name:string;description:string;kind:string;status:string;priority:string;queue_id:string|null;assignee_id:string|null;contact_id:string|null;company_id:string|null;conversation_id:string|null;due_at:string|null;first_response_minutes:number;resolution_minutes:number;warning_fraction:number;first_responded_at:string|null;resolved_at:string|null;escalated:boolean;escalation_reason:string }
export interface EditorialDraft extends ProductRecord {name:string;body:string;campaign:string;state:string;scheduled_at:string|null;timezone:string;reviewed_by:string|null;reviewed_at:string|null}
export interface EditorialVariant extends ProductRecord {draft_id:string;channel_id:string;body:string;media_refs:string[]}
export interface KnowledgeSource extends ProductRecord {name:string;source_ref:string;enabled:boolean}
export interface MailboxIdentity extends ProductRecord {name:string;address:string;gateway_account_ref:string}
export interface CannedReply extends ProductRecord {name:string;body:string}
export interface OperatorNotification {id:string;workspace_id:string;recipient_id:string;title:string;kind:string;entity_type:string;entity_id:string;dedupe_key:string;created_at:string;read_at:string|null}
export interface CustomerNote { conversation_id:string|null;mention_ids:string[]; work_item_id:string|null; id: string; workspace_id: string; company_id: string | null; contact_id: string | null; deal_id: string | null; body: string; author_id: string; created_at: string }
export interface ProductActivity { id: string; workspace_id: string; entity_type: string; entity_id: string; actor_id: string | null; action: string; changes: Json; created_at: string }
type Table<Row, Required extends keyof Row> = { Row: { [K in keyof Row]: Row[K] }; Insert: Pick<Row, Required> & Partial<Row>; Update: Partial<Row>; Relationships: [] };
export type ProductTables = {
  editorial_drafts:Table<EditorialDraft,"workspace_id"|"name">;
  editorial_variants:Table<EditorialVariant,"workspace_id"|"draft_id"|"channel_id"|"body">;
  knowledge_sources:Table<KnowledgeSource,"workspace_id"|"name"|"source_ref">;
  mailbox_identities:Table<MailboxIdentity,"workspace_id"|"name"|"address">;
  canned_replies:Table<CannedReply,"workspace_id"|"name"|"body">;
  operator_notifications:Table<OperatorNotification,"workspace_id"|"recipient_id"|"title"|"kind"|"entity_type"|"entity_id"|"dedupe_key">;
  work_items: Table<WorkItem,"workspace_id"|"name">;
  work_queues: Table<WorkQueue,"workspace_id"|"name">;
  companies: Table<Company, "workspace_id" | "name">;
  customer_profiles: Table<CustomerProfile, "workspace_id" | "contact_id">;
  deals: Table<Deal, "workspace_id" | "name">;
  customer_notes: Table<CustomerNote, "workspace_id" | "body">;
  product_activity: Table<ProductActivity, "workspace_id" | "entity_type" | "entity_id" | "action">;
}
