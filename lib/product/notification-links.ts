export function notificationLink(kind: string, id: string): string | null {
  if (!/^[\da-f-]{36}$/i.test(id)) return null;
  const paths: Record<string, string> = {
    work_items: "/dashboard/work-items/",
    companies: "/dashboard/crm/companies/",
    deals: "/dashboard/crm/deals/",
    contacts: "/dashboard/contacts/",
    conversations: "/dashboard/inbox?conversationId=",
    secrets: "/dashboard/secrets?secret=",
    tasks: "/dashboard/jobs/",
    browser_sessions: "/dashboard/browser-sessions/",
    campaigns: "/dashboard/campaigns/",
    artifacts: "/dashboard/assets?asset=",
    editorial_drafts: "/dashboard/content/",
  };
  return Object.hasOwn(paths, kind)
    ? paths[kind] + encodeURIComponent(id)
    : null;
}
