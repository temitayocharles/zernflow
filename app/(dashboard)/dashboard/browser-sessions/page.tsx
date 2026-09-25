import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { ActionButton } from "@/components/ops/action-button";
import { AttestForm, CreateBrowserSessionForm, ImportStateForm } from "@/components/ops/browser-session-forms";
import { browserPlatforms } from "@/lib/browser/registry";
import { checkBlocker, HUMAN_STATES, SESSION_COLUMNS } from "@/lib/browser-sessions/service";
import { secretStoreConfigured } from "@/lib/secrets/kek";
import type { BrowserSessionRow } from "@/lib/types/platform";

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : "never";
}

const LEVEL_STYLE: Record<string, string> = {
  verified: "bg-emerald-500/15",
  experimental: "bg-amber-500/15",
  unsupported: "text-muted-foreground",
};

const STATUS_HELP: Record<string, string> = {
  unverified: "State imported; waiting for its first check.",
  healthy: "Signed in when last checked.",
  degraded: "Signed-in cookie present but the page looked unexpected. Check again or re-import.",
  human_login_required: "Sign in yourself and import a fresh session file.",
  mfa_required: "The platform asked for a verification code. Complete it in your own browser and re-import.",
  challenge_required: "The platform showed a security check. Resolve it yourself, then re-import. ZernFlow never solves these.",
  expired: "The session cookie expired. Sign in again and re-import.",
  revoked: "Revoked. The stored state was destroyed.",
};

export default async function BrowserSessionsPage() {
  const { supabase, workspace, role } = await getWorkspace();
  const isOwner = role === "owner";
  const configured = secretStoreConfigured();
  const platforms = browserPlatforms();
  const [{ data, error }, { data: workers }] = await Promise.all([
    supabase.from("browser_sessions").select(SESSION_COLUMNS).eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(100),
    // Owner-only by RLS; members simply see nothing here.
    supabase.from("worker_identities").select("id, name, modes, last_seen_at, version, revoked_at").eq("workspace_id", workspace.id).contains("modes", ["browser"]).is("revoked_at", null),
  ]);
  const sessions = (data ?? []) as BrowserSessionRow[];
  const labels = new Map(platforms.map((p) => [p.platform, p.label]));
  const operations = [...new Set(platforms.flatMap((p) => p.capabilities.map((c) => c.operation)))];

  return (
    <main className="space-y-6 overflow-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Browser sessions</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The last-resort execution path, used only where no official API or Gateway adapter covers an operation. You sign in yourself; ZernFlow
          stores the resulting session encrypted and runs short, read-only checks in an ephemeral job with one browser at a time. It never enters
          passwords, solves CAPTCHAs, or completes verification prompts. When the platform asks for you, the job stops and you are notified.
        </p>
      </header>

      {!configured && (
        <p role="alert" className="rounded-lg border border-amber-500/50 p-3 text-sm">
          The secret store is not configured, so session files cannot be stored. See <Link href="/dashboard/secrets" className="underline">Secrets</Link>.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Platform capabilities</h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Platform</th>
                {operations.map((op) => (
                  <th key={op} className="p-2">
                    {op.replaceAll("_", " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {platforms.map((p) => (
                <tr key={p.platform}>
                  <td className="p-2 font-medium">{p.label}</td>
                  {operations.map((op) => {
                    const cap = p.capabilities.find((c) => c.operation === op);
                    const level = cap?.level ?? "unsupported";
                    return (
                      <td key={op} className="p-2" title={cap?.note}>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${LEVEL_STYLE[level] ?? ""}`}>{level}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          <strong>verified</strong>: contract-tested against the live platform. <strong>experimental</strong>: implemented and tested against fixtures only; each
          session must opt in. <strong>unsupported</strong>: not offered. Publishing through the browser stays unavailable until an adapter is verified.
        </p>
      </section>

      {isOwner ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Add a session</h2>
          <CreateBrowserSessionForm platforms={platforms} disabled={!configured} />
          <details className="rounded-xl border border-border p-4 text-sm">
            <summary className="cursor-pointer font-medium">How to create a session file</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                On your own computer, run <code>npx playwright codegen --save-storage=state.json https://www.instagram.com/</code> (use the platform&apos;s
                address).
              </li>
              <li>Sign in normally in the window that opens, including any verification code the platform asks for.</li>
              <li>Close the window. Import the resulting <code>state.json</code> below, then delete your local copy.</li>
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">
              Cookies for other sites are rejected. The file is encrypted before storage and never displayed again.
            </p>
          </details>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Only workspace owners can add, import or revoke browser sessions. Members can request checks.</p>
      )}

      {error ? (
        <p role="alert">Browser sessions are unavailable. Apply migrations 00032 and 00035.</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No browser sessions yet.</p>
      ) : (
        <ul className="space-y-3">
          {sessions.map((s) => {
            const blocker = checkBlocker(s);
            const attention = HUMAN_STATES.includes(s.status);
            const revoked = s.status === "revoked";
            return (
              <li key={s.id} className="space-y-3 rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="font-medium">
                      {s.label} <span className="text-sm text-muted-foreground">· {labels.get(s.platform) ?? s.platform}</span>
                      {s.account_hint && <span className="text-sm text-muted-foreground"> · {s.account_hint}</span>}
                      <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${attention ? "bg-destructive/15 text-destructive" : s.status === "healthy" ? "bg-emerald-500/15" : "border border-border"}`}>
                        {s.status.replaceAll("_", " ")}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">{STATUS_HELP[s.status]}</p>
                    <p className="text-xs text-muted-foreground">
                      Last verified {when(s.last_verified_at)}
                      {s.expires_at && ` · cookie expires ${when(s.expires_at)}`}
                      {s.last_check_task_id && (
                        <>
                          {" "}
                          · <Link href={`/dashboard/jobs/${s.last_check_task_id}`} className="underline">last check job</Link>
                        </>
                      )}
                    </p>
                    {s.last_error && <p className="text-xs text-destructive">{s.last_error}</p>}
                  </div>
                  {!revoked && (
                    <div className="flex flex-wrap items-center gap-2">
                      {!blocker && <ActionButton url={`/api/v1/browser-sessions/${s.id}/check`} label="Check now" />}
                      {isOwner && (
                        <ActionButton
                          url={`/api/v1/browser-sessions/${s.id}/revoke`}
                          label="Revoke"
                          variant="danger"
                          confirm="Revoke this session? The stored session is destroyed and pending browser jobs are cancelled."
                        />
                      )}
                    </div>
                  )}
                </div>
                {!revoked && blocker && <p className="text-xs text-muted-foreground">Checks are off: {blocker}</p>}
                {isOwner && !revoked && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{s.storage_state_secret_id ? "Replace session file" : "Import session file"}</p>
                      <ImportStateForm sessionId={s.id} />
                    </div>
                    <AttestForm sessionId={s.id} confirmed={s.permitted_use_confirmed} allowExperimental={s.allow_experimental} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {isOwner && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Browser executor</h2>
          {(workers ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No browser worker is registered. Checks wait in <Link href="/dashboard/jobs" className="underline">Jobs</Link> until one runs.{" "}
              <Link href="/dashboard/jobs/workers" className="underline">Register a worker</Link> with the browser mode and run the browser-executor job.
            </p>
          ) : (
            <ul className="text-sm">
              {(workers ?? []).map((w) => (
                <li key={w.id}>
                  {w.name} · {w.version ? `v${w.version}` : "version unknown"} · last seen {when(w.last_seen_at)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
