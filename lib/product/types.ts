import type { Json } from "@/lib/types/database";
export interface ProductRecord { id: string; workspace_id: string; version: number; created_at: string; updated_at: string }
export interface Company extends ProductRecord { name: string; domain: string; description: string; owner_id: string | null; lifecycle: string; source: string }
export interface CustomerProfile extends ProductRecord { contact_id: string; company_id: string | null; owner_id: string | null; lifecycle: string; source: string; lead_score: number }
export interface Deal extends ProductRecord { name: string; description: string; company_id: string | null; contact_id: string | null; owner_id: string | null; stage: string; value_minor: number; currency: string; expected_close_at: string | null; closed_at: string | null }
export interface WorkQueue extends ProductRecord { name:string;description:string }
export interface WorkItem extends ProductRecord { reference:number;name:string;description:string;kind:string;status:string;priority:string;queue_id:string|null;assignee_id:string|null;contact_id:string|null;company_id:string|null;conversation_id:string|null;due_at:string|null;first_response_minutes:number;resolution_minutes:number;warning_fraction:number;first_responded_at:string|null;resolved_at:string|null;escalated:boolean;escalation_reason:string }
export interface CustomerNote { work_item_id:string|null; id: string; workspace_id: string; company_id: string | null; contact_id: string | null; deal_id: string | null; body: string; author_id: string; created_at: string }
export interface ProductActivity { id: string; workspace_id: string; entity_type: string; entity_id: string; actor_id: string | null; action: string; changes: Json; created_at: string }
type Table<Row, Required extends keyof Row> = { Row: { [K in keyof Row]: Row[K] }; Insert: Pick<Row, Required> & Partial<Row>; Update: Partial<Row>; Relationships: [] };
export type ProductTables = {
  work_items: Table<WorkItem,"workspace_id"|"name">;
  work_queues: Table<WorkQueue,"workspace_id"|"name">;
  companies: Table<Company, "workspace_id" | "name">;
  customer_profiles: Table<CustomerProfile, "workspace_id" | "contact_id">;
  deals: Table<Deal, "workspace_id" | "name">;
  customer_notes: Table<CustomerNote, "workspace_id" | "body">;
  product_activity: Table<ProductActivity, "workspace_id" | "entity_type" | "entity_id" | "action">;
}
