import type { LucideIcon } from "lucide-react";
import {
  BarChart3, Bell, BookOpen, Building2, CalendarDays, ClipboardList, FileText, GitBranch, HeartPulse, Image,
  Inbox, KeyRound, LayoutDashboard, LineChart, ListChecks, ListOrdered, Mail, Megaphone, MessageSquareText, Plug,
  Radio, ScrollText, Settings, Sprout, UserCog, Users, MonitorSmartphone } from "lucide-react";

export interface NavItem { name: string; href: string; icon: LucideIcon; ownerOnly?: boolean; exact?: boolean }
export interface NavGroup { label: string | null; items: NavItem[] }

/**
 * Control-plane information architecture (docs/architecture/TARGET_ARCHITECTURE.md §7).
 * Every entry is a real page; Browser sessions joins "Operate" when the browser plane (R6) ships.
 */
export const NAVIGATION: NavGroup[] = [
  { label: null, items: [{ name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, exact: true }] },
  {
    label: "Plan",
    items: [
      { name: "Campaigns", href: "/dashboard/campaigns", icon: Megaphone },
      { name: "Content", href: "/dashboard/content", icon: FileText },
      { name: "Calendar", href: "/dashboard/calendar", icon: CalendarDays },
      { name: "Assets", href: "/dashboard/assets", icon: Image },
    ],
  },
  {
    label: "Engage",
    items: [
      { name: "Inbox", href: "/dashboard/inbox", icon: Inbox },
      { name: "Automations", href: "/dashboard/flows", icon: GitBranch },
      { name: "Sequences", href: "/dashboard/sequences", icon: ListOrdered },
      { name: "Broadcasts", href: "/dashboard/broadcasts", icon: Radio },
      { name: "Growth tools", href: "/dashboard/growth", icon: Sprout },
      { name: "Canned replies", href: "/dashboard/canned-replies", icon: MessageSquareText },
      { name: "Knowledge", href: "/dashboard/knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Customers",
    items: [
      { name: "Contacts", href: "/dashboard/contacts", icon: Users },
      { name: "Companies & deals", href: "/dashboard/crm/companies", icon: Building2 },
      { name: "Work items", href: "/dashboard/work-items", icon: ClipboardList },
    ],
  },
  {
    label: "Operate",
    items: [
      { name: "Jobs", href: "/dashboard/jobs", icon: ListChecks },
      { name: "Connected accounts", href: "/dashboard/channels", icon: Plug },
      { name: "Browser sessions", href: "/dashboard/browser-sessions", icon: MonitorSmartphone },
      { name: "Notifications", href: "/dashboard/notifications", icon: Bell },
    ],
  },
  {
    label: "Analytics",
    items: [
      { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
      { name: "Team performance", href: "/dashboard/operations", icon: LineChart },
    ],
  },
  {
    label: "Admin",
    items: [
      { name: "Secrets", href: "/dashboard/secrets", icon: KeyRound },
      { name: "Team", href: "/dashboard/settings/team", icon: UserCog },
      { name: "System health", href: "/dashboard/system-health", icon: HeartPulse, ownerOnly: true },
      { name: "Audit log", href: "/dashboard/audit", icon: ScrollText },
      { name: "Email identities", href: "/dashboard/configuration/mailbox_identities", icon: Mail },
      { name: "Settings", href: "/dashboard/settings", icon: Settings },
    ],
  },
];

/** The single most specific nav entry for a path (so /settings/team does not also light up Settings). */
export function activeHref(pathname: string, groups: NavGroup[] = NAVIGATION): string | null {
  let best: string | null = null;
  for (const g of groups)
    for (const i of g.items) {
      const match = i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
      if (match && (!best || i.href.length > best.length)) best = i.href;
    }
  return best;
}
