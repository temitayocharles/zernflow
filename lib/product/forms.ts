export interface Field {
  key: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select" | "datetime-local";
  required?: boolean;
  choices?: readonly string[];
  max?: number;
  reference?: "contacts" | "companies" | "queues" | "members";
}
export const crmForms: Record<string, { title: string; fields: Field[] }> = {
  companies: {
    title: "Companies",
    fields: [
      { key: "name", label: "Company name", required: true },
      { key: "domain", label: "Domain" },
      { key: "description", label: "Description", type: "textarea" },
      {
        key: "lifecycle",
        label: "Lifecycle",
        type: "select",
        choices: ["lead", "qualified", "customer", "inactive"],
      },
      { key: "source", label: "Source attribution" },
      { key: "owner_id", label: "Owner", reference: "members" },
    ],
  },
  deals: {
    title: "Opportunities",
    fields: [
      { key: "name", label: "Opportunity name", required: true },
      { key: "description", label: "Description", type: "textarea" },
      {
        key: "stage",
        label: "Stage",
        type: "select",
        choices: ["new", "qualified", "proposal", "negotiation", "won", "lost"],
      },
      {
        key: "value_minor",
        label: "Value in minor currency units",
        type: "number",
        max: Number.MAX_SAFE_INTEGER,
      },
      { key: "currency", label: "Currency (ISO code)" },
      {
        key: "expected_close_at",
        label: "Expected close",
        type: "datetime-local",
      },
      { key: "company_id", label: "Company", reference: "companies" },
      { key: "contact_id", label: "Contact", reference: "contacts" },
      { key: "owner_id", label: "Owner", reference: "members" },
    ],
  },
  customer_profiles: {
    title: "Customer profiles",
    fields: [
      {
        key: "contact_id",
        label: "Contact",
        reference: "contacts",
        required: true,
      },
      { key: "company_id", label: "Company", reference: "companies" },
      { key: "owner_id", label: "Owner", reference: "members" },
      {
        key: "lifecycle",
        label: "Lifecycle",
        type: "select",
        choices: ["lead", "qualified", "customer", "inactive"],
      },
      { key: "source", label: "Source attribution" },
      {
        key: "lead_score",
        label: "Lead score (0–100)",
        type: "number",
        max: 100,
      },
    ],
  },
};
export const workFields: Field[] = [
  { key: "name", label: "Title", required: true },
  { key: "description", label: "Description", type: "textarea" },
  {
    key: "kind",
    label: "Type",
    type: "select",
    choices: ["ticket", "task", "incident", "follow_up"],
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    choices: ["normal", "low", "high", "urgent"],
  },
  { key: "queue_id", label: "Queue", reference: "queues" },
  { key: "assignee_id", label: "Assignee", reference: "members" },
  { key: "contact_id", label: "Requester contact", reference: "contacts" },
  { key: "company_id", label: "Company", reference: "companies" },
  { key: "conversation_id", label: "Originating conversation ID" },
  { key: "due_at", label: "Due date", type: "datetime-local" },
];
export const configurationForms: Record<
  string,
  { title: string; description: string; fields: Field[] }
> = {
  editorial_drafts: {
    title: "Editorial drafts",
    description:
      "Local editorial planning and owner approval. A scheduled date is intent only; nothing is queued or published until a Gateway execution adapter is accepted.",
    fields: [
      { key: "name", label: "Title", required: true },
      { key: "body", label: "Content", type: "textarea" },
      { key: "campaign", label: "Campaign group" },
      {
        key: "state",
        label: "Editorial review state",
        type: "select",
        choices: ["draft", "in_review", "approved"],
      },
      {
        key: "scheduled_at",
        label: "Requested publication time",
        type: "datetime-local",
      },
      { key: "timezone", label: "Display timezone (IANA)" },
    ],
  },
  knowledge_sources: {
    title: "Knowledge sources",
    description:
      "References to sources in the external knowledge system. Enabling a source permits retrieval; it does not start indexing or claim that indexing is complete.",
    fields: [
      { key: "name", label: "Name", required: true },
      {
        key: "source_ref",
        label: "External source reference (not a credential)",
        required: true,
      },
      {
        key: "enabled",
        label: "Allow retrieval",
        type: "select",
        choices: ["false", "true"],
      },
    ],
  },
  mailbox_identities: {
    title: "Email identities",
    description:
      "Sender identity configuration only. Runtime email connection, inbound synchronization and outbound dispatch remain unavailable until the Gateway email connector is wired and accepted. Never enter mailbox credentials here.",
    fields: [
      { key: "name", label: "Sender display name", required: true },
      { key: "address", label: "Email address", required: true },
      {
        key: "gateway_account_ref",
        label: "Gateway mailbox account reference (optional)",
      },
    ],
  },
};
