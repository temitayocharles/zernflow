const TONES: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  healthy: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  available: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  succeeded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  publishing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  queued: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  scheduled: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  waiting: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  retrying: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  partially_published: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  degraded: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  paused: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  waiting_for_user: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  pending: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  human_login_required: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  mfa_required: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  challenge_required: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  expired: "bg-red-500/15 text-red-700 dark:text-red-300",
  revoked: "bg-red-500/15 text-red-700 dark:text-red-300",
  unknown: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONES[state] ?? "bg-muted text-muted-foreground"}`}>
      {state.replaceAll("_", " ")}
    </span>
  );
}
