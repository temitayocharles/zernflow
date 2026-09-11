import { Pagination } from "@/components/product/pagination";
import { SlaRefresh } from "@/components/product/sla-refresh";
import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { notificationLink } from "@/lib/product/notification-links";
import { NotificationRead } from "@/components/product/notification-read";
export default async function Notifications({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(
    0,
    Math.min(10000, Math.floor(Number((await searchParams).page) || 0)),
  );
  const { supabase, workspace, user } = await getWorkspace();
  const { data, error, count } = await supabase
    .from("operator_notifications")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspace.id)
    .eq("recipient_id", user.id)
    .order("created_at", { ascending: false })
    .order("id")
    .range(page * 50, page * 50 + 49);
  return (
    <main className="space-y-4 overflow-auto p-6">
      <h1 className="text-2xl font-semibold">Notifications</h1>
      <SlaRefresh />
      <p className="text-sm text-muted-foreground">
        Latest 100 assignments, mentions, escalations and ticket updates for you
        in this workspace.
      </p>
      <Pagination page={page} total={count ?? 0} />
      {error ? (
        <p role="alert">Notifications unavailable. Apply migration 00023.</p>
      ) : data?.length ? (
        data.map((n) => {
          const href = notificationLink(n.entity_type, n.entity_id);
          return (
            <article
              key={n.id}
              className="space-y-2 rounded-xl border border-border p-4"
            >
              {href ? (
                <Link
                  className={
                    n.read_at
                      ? "text-muted-foreground"
                      : "font-semibold underline"
                  }
                  href={href}
                >
                  {n.title}
                </Link>
              ) : (
                <p>{n.title}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {new Date(n.created_at).toLocaleString()}
              </p>
              {!n.read_at && <NotificationRead id={n.id} />}
            </article>
          );
        })
      ) : (
        <p className="text-sm text-muted-foreground">No notifications yet.</p>
      )}
    </main>
  );
}
