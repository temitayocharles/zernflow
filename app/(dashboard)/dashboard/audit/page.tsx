import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { memberDirectory } from "@/lib/workspace-directory";
import { auditKeysetFilter, changedFields, mergeAudit, parseAuditCursor, type AuditEntry } from "@/lib/health/audit";
import { notificationLink } from "@/lib/product/notification-links";

const PAGE = 50;
const SOURCES = ["all", "records", "secrets"] as const;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ source?: string; entity?: string; before?: string }> }) {
  const sp = await searchParams;
  const source = SOURCES.find((s) => s === sp.source) ?? "all";
  const entity = sp.entity && /^[a-z_]{1,64}$/.test(sp.entity) ? sp.entity : null;
  const cursor = parseAuditCursor(sp.before);
  const keyset = cursor ? auditKeysetFilter(cursor) : null;
  const before = cursor ? sp.before : null;
  const { supabase, workspace } = await getWorkspace();

  let records: AuditEntry[] = [];
  let secrets: AuditEntry[] = [];
  let failed = false;
  if (source !== "secrets") {
    let q = supabase.from("product_activity").select("id, entity_type, entity_id, actor_id, action, changes, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE + 1);
    if (entity) q = q.eq("entity_type", entity);
    if (keyset) q = "lt" in keyset ? q.lt("created_at", keyset.lt) : q.or(keyset.or);
    const { data, error } = await q;
    failed ||= Boolean(error);
    records = (data ?? []).map((r) => ({
      id: r.id, source: "records", at: r.created_at, actorId: r.actor_id, actorType: r.actor_id ? "user" : "system",
      action: r.action, entityType: r.entity_type, entityId: r.entity_id, outcome: "success", detail: changedFields(r.changes),
    }));
  }
  if (source !== "records" && (!entity || entity === "secrets")) {
    let q = supabase.from("secret_access_events").select("id, secret_id, action, actor_type, actor_id, purpose, outcome, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE + 1);
    if (keyset) q = "lt" in keyset ? q.lt("created_at", keyset.lt) : q.or(keyset.or);
    const { data, error } = await q;
    failed ||= Boolean(error);
    secrets = (data ?? []).map((r) => ({
      id: r.id, source: "secrets", at: r.created_at, actorId: r.actor_type === "user" ? r.actor_id : null, actorType: r.actor_type,
      action: `secret.${r.action}`, entityType: "secrets", entityId: r.secret_id, outcome: r.outcome, detail: r.purpose ? `purpose: ${r.purpose}` : "",
    }));
  }
  const { entries, nextBefore } = mergeAudit(records, secrets, PAGE);
  const people = entries.some((e) => e.actorId) ? await memberDirectory(workspace.id) : new Map();
  const entityTypes = [...new Set(records.map((r) => r.entityType))].sort();
  const qs = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ source: source === "all" ? null : source, entity, ...extra })) if (v) p.set(k, v);
    return `/dashboard/audit${p.size ? `?${p}` : ""}`;
  };
  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">Who changed what, and every secret access. Changed values are not shown here; open the record for details.</p>
      </header>
      <form action="/dashboard/audit" className="flex flex-wrap items-end gap-2 text-sm">
        <label>Source
          <select name="source" defaultValue={source} className="ml-2 rounded border border-border bg-background p-1">
            <option value="all">All</option><option value="records">Records</option><option value="secrets">Secrets</option>
          </select>
        </label>
        <label>Record type<input name="entity" defaultValue={entity ?? ""} list="audit-entities" placeholder="any" className="ml-2 w-40 rounded border border-border bg-background p-1" /></label>
        <datalist id="audit-entities">{entityTypes.map((t) => <option key={t} value={t} />)}</datalist>
        <button className="rounded border border-border px-2 py-1">Filter</button>
      </form>
      {failed && <p role="alert" className="text-sm text-destructive">Part of the audit log could not be loaded.</p>}
      {entries.length === 0 ? <p className="text-sm text-muted-foreground">No audit events.</p> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">When</th><th className="p-2">Actor</th><th className="p-2">Action</th><th className="p-2">Record</th><th className="p-2">Outcome</th></tr></thead>
          <tbody className="divide-y divide-border">
            {entries.map((e) => {
              const href = e.entityId ? (e.entityType === "secrets" ? "/dashboard/secrets" : notificationLink(e.entityType, e.entityId)) : null;
              return (
                <tr key={`${e.source}:${e.id}`}>
                  <td className="whitespace-nowrap p-2">{new Date(e.at).toLocaleString()}</td>
                  <td className="p-2">{e.actorId ? (people.get(e.actorId)?.label ?? "Former member") : e.actorType}</td>
                  <td className="p-2">{e.action}{e.detail && <span className="block text-xs text-muted-foreground">{e.detail}</span>}</td>
                  <td className="p-2">{href ? <Link href={href} className="hover:underline">{e.entityType}</Link> : e.entityType}</td>
                  <td className={`p-2 ${e.outcome === "success" ? "" : "text-destructive"}`}>{e.outcome}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <nav aria-label="Pages" className="flex gap-3 text-sm">
        {before && <Link href={qs({})}>← Newest</Link>}
        {nextBefore && <Link href={qs({ before: nextBefore })}>Older →</Link>}
      </nav>
    </div>
  );
}
