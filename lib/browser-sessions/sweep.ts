import "server-only";
import type { ServiceClient } from "@/lib/tasks/types";
import type { BrowserSessionRow } from "@/lib/types/platform";
import { notifyOwners } from "@/lib/product/notify";
import { checkBlocker, requestSessionCheck, SESSION_COLUMNS } from "./service";

/**
 * Bounded maintenance for browser sessions:
 *  1. sessions past their auth-cookie expiry become `expired` (owners notified once);
 *  2. usable sessions not verified within BROWSER_SESSION_CHECK_HOURS get one queued
 *     read-only check (the queue waits for the free browser job; nothing scales).
 */
export async function sweepBrowserSessions(service: ServiceClient, env: Record<string, string | undefined> = process.env, now = new Date()) {
  const hours = Math.max(0, Math.min(24 * 30, Number(env.BROWSER_SESSION_CHECK_HOURS ?? 24) || 0));
  const { data: expiring } = await service
    .from("browser_sessions")
    .select(SESSION_COLUMNS)
    .in("status", ["unverified", "healthy", "degraded"])
    .lt("expires_at", now.toISOString())
    .limit(100);
  let expired = 0;
  for (const s of (expiring ?? []) as BrowserSessionRow[]) {
    const { error } = await service.from("browser_sessions").update({ status: "expired", last_error: "The platform session cookie has expired. Sign in and re-import." } as never).eq("id", s.id).eq("workspace_id", s.workspace_id);
    if (error) continue;
    expired++;
    await notifyOwners(service, {
      workspaceId: s.workspace_id, title: `Browser session “${s.label}” expired`, kind: "browser_session_attention",
      entityType: "browser_sessions", entityId: s.id, dedupeKey: `browser-session:${s.id}:expired:${now.toISOString().slice(0, 10)}`,
    });
  }
  if (hours === 0) return { expired, checksQueued: 0 };
  const staleBefore = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const { data: candidates } = await service
    .from("browser_sessions")
    .select(SESSION_COLUMNS)
    .in("status", ["unverified", "healthy", "degraded"])
    .eq("permitted_use_confirmed", true)
    .order("last_verified_at", { ascending: true, nullsFirst: true })
    .limit(50);
  const stale = ((candidates ?? []) as BrowserSessionRow[]).filter((s) => !s.last_verified_at || s.last_verified_at < staleBefore).slice(0, 20);
  let checksQueued = 0;
  for (const s of stale) {
    if (checkBlocker(s)) continue;
    try {
      const r = await requestSessionCheck(service, { workspaceId: s.workspace_id, sessionId: s.id, actorId: null, reason: "scheduled", now });
      if (r.created) checksQueued++;
    } catch {
      /* next sweep retries */
    }
  }
  return { expired, checksQueued };
}
