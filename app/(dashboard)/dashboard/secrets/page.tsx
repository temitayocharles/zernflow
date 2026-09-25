import { getWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/ops/action-button";
import { CreateSecretForm, RotateSecretForm } from "@/components/ops/secret-forms";
import { secretStoreConfigured } from "@/lib/secrets/kek";
import { SECRET_METADATA_COLUMNS } from "@/lib/secrets/store";
import type { SecretRow } from "@/lib/types/platform";

/** Server-rendered per request; expiry is evaluated at render time. */
function expiryState(expiresAt: string | null): "expired" | "soon" | null {
  if (!expiresAt) return null;
  const left = new Date(expiresAt).getTime() - Date.now();
  return left <= 0 ? "expired" : left < 14 * 86400_000 ? "soon" : null;
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : "never";
}

export default async function SecretsPage() {
  const { supabase, workspace, role } = await getWorkspace();
  const isOwner = role === "owner";
  const configured = secretStoreConfigured();
  const [{ data, error }, { data: events }, { data: legacy }] = await Promise.all([
    supabase
      .from("secrets")
      .select(SECRET_METADATA_COLUMNS)
      .eq("workspace_id", workspace.id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false }),
    supabase
      .from("secret_access_events")
      .select("id, secret_id, action, actor_type, actor_id, purpose, outcome, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(25),
    // Only whether a legacy value exists is checked, server-side, never the value.
    isOwner
      ? createServiceClient().then((s) => s.from("workspaces").select("ai_api_key").eq("id", workspace.id).single())
      : Promise.resolve({ data: null }),
  ]);
  const secrets = (data ?? []) as SecretRow[];
  const names = new Map(secrets.map((s) => [s.id, s.name]));
  const hasLegacy = Boolean((legacy as { ai_api_key?: string | null } | null)?.ai_api_key);

  return (
    <main className="space-y-5 overflow-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Secrets</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Envelope-encrypted with AES-256-GCM; data keys are wrapped by the deployment key provider (Vault Transit in
          production), which never stores its root key in the database. Values are write-only: nobody, including
          owners, can read them back in the browser. Provider OAuth tokens stay in Agent Social Gateway.
        </p>
      </header>

      {!configured && (
        <p role="alert" className="rounded-lg border border-amber-500/50 p-3 text-sm">
          The secret store is not configured on this deployment. Set <code>SECRET_STORE_KEK_PROVIDER=vault-transit</code>{" "}
          with <code>VAULT_ADDR</code>, <code>VAULT_TOKEN</code> and <code>VAULT_TRANSIT_KEY</code> (or{" "}
          <code>ZERNFLOW_LOCAL_KEK</code> for development).
        </p>
      )}

      {isOwner && hasLegacy && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/50 p-3 text-sm">
          <span>A legacy plaintext AI key is stored on this workspace. Move it into the encrypted store.</span>
          <ActionButton url="/api/v1/secrets/import-legacy" label="Encrypt and import" />
        </div>
      )}

      {isOwner ? <CreateSecretForm disabled={!configured} /> : <p className="text-sm text-muted-foreground">Only workspace owners can add or change secrets.</p>}

      {error ? (
        <p role="alert">Secrets unavailable. Apply migration 00032.</p>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets stored yet.</p>
      ) : (
        <ul className="space-y-2">
          {secrets.map((s) => {
            const expiry = expiryState(s.expires_at);
            const expired = expiry === "expired";
            const expiringSoon = expiry === "soon";
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
                <div className="space-y-0.5">
                  <p className="font-medium">
                    {s.name} <span className="font-mono text-xs text-muted-foreground">••••••••</span>
                    <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs">{s.status}</span>
                    {expired && <span className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">expired</span>}
                    {expiringSoon && <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs">expires soon</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.kind.replaceAll("_", " ")}
                    {s.provider && ` · ${s.provider}`}
                    {s.binding && (
                      <>
                        {" "}
                        · binding <code>{s.binding}</code>
                      </>
                    )}{" "}
                    · v{s.current_version} · last used {when(s.last_used_at)}
                    {s.last_used_by && ` by ${s.last_used_by.split(":")[0]}`}
                    {s.expires_at && ` · expires ${when(s.expires_at)}`}
                  </p>
                </div>
                {isOwner && (
                  <div className="flex flex-wrap items-center gap-2">
                    {s.status === "active" && (
                      <>
                        <RotateSecretForm secretId={s.id} />
                        <ActionButton url={`/api/v1/secrets/${s.id}`} body={{ action: "revoke" }} label="Revoke" confirm="Revoke this secret? Anything using it stops working." />
                      </>
                    )}
                    <ActionButton url={`/api/v1/secrets/${s.id}`} method="DELETE" label="Delete" variant="danger" confirm="Permanently destroy this secret's ciphertext? This cannot be undone." />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent access</h2>
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {(events ?? []).length === 0 && <li className="p-3 text-muted-foreground">No access recorded.</li>}
          {(events ?? []).map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 p-3">
              <span>
                <strong>{e.action}</strong> {e.secret_id ? names.get(e.secret_id) ?? "deleted secret" : ""}
                {e.purpose && <span className="text-muted-foreground"> · {e.purpose}</span>}
                <span className={e.outcome === "success" ? "text-muted-foreground" : "text-destructive"}> · {e.outcome}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {e.actor_type} · {new Date(e.created_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
