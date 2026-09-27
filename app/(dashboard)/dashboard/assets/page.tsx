import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { getObjectStore, objectStoreConfigured } from "@/lib/storage";
import { readBudget } from "@/lib/runtime/budget";
import { ARTIFACT_COLUMNS } from "@/lib/artifacts/service";
import { ALL_KINDS, contentDisposition } from "@/lib/artifacts/policy";
import { AssetUpload } from "@/components/ops/asset-upload";
import { ActionButton } from "@/components/ops/action-button";
import type { ArtifactRow } from "@/lib/types/platform";

const PAGE = 48;

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ kind?: string; page?: string }> }) {
  const sp = await searchParams;
  const { supabase, workspace, role, user } = await getWorkspace();
  const page = Math.max(1, Number(sp.page) || 1);
  const kind = ALL_KINDS.includes(sp.kind as ArtifactRow["kind"]) ? (sp.kind as ArtifactRow["kind"]) : null;
  const configured = objectStoreConfigured();
  const budget = readBudget();

  let query = supabase
    .from("artifacts")
    .select(ARTIFACT_COLUMNS, { count: "exact" })
    .eq("workspace_id", workspace.id)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (kind) query = query.eq("kind", kind);
  const [{ data, error, count }, usage] = await Promise.all([
    query,
    createServiceClient().then((s) =>
      s.from("artifacts").select("size_bytes").eq("workspace_id", workspace.id).in("status", ["pending_upload", "available", "quarantined"]),
    ),
  ]);
  const assets = (data ?? []) as ArtifactRow[];
  const used = (usage.data ?? []).reduce((sum, r) => sum + Number(r.size_bytes), 0);

  // Presigning is a local signature computation (no network); URLs expire in 5 minutes.
  const previews = new Map<string, string>();
  if (configured) {
    const store = getObjectStore();
    await Promise.all(
      assets
        .filter((a) => a.status === "available" && a.content_type.startsWith("image/"))
        .map(async (a) =>
          previews.set(
            a.id,
            await store.presignGet(a.object_key, { expiresInSeconds: 300, contentType: a.content_type, disposition: contentDisposition(a.content_type, a.file_name || "file") }),
          ),
        ),
    );
  }

  return (
    <main className="space-y-5 overflow-auto p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Assets</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Media and files for campaigns and posts, plus screenshots and traces from job runs. Stored in private
            S3-compatible storage under this workspace&apos;s prefix; every download is a short-lived signed link.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {size(used)} of {size(budget.maxWorkspaceStorageBytes)} used · max file {size(budget.maxUploadSizeBytes)}
        </p>
      </header>

      {!configured && (
        <p role="alert" className="rounded-lg border border-amber-500/50 p-3 text-sm">
          Artifact storage is not configured. Set <code>ARTIFACT_S3_ENDPOINT</code>, <code>ARTIFACT_S3_BUCKET</code>,{" "}
          <code>ARTIFACT_S3_ACCESS_KEY_ID</code> and <code>ARTIFACT_S3_SECRET_ACCESS_KEY</code> (any S3-compatible
          provider, e.g. a free-tier bucket or MinIO on your own cluster).
        </p>
      )}

      <AssetUpload disabled={!configured} maxBytes={budget.maxUploadSizeBytes} />

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter by kind">
        <Link href="/dashboard/assets" className={`rounded-full border px-3 py-1 ${!kind ? "border-primary" : "border-border"}`}>
          All
        </Link>
        {(["image", "video", "document", "screenshot", "trace", "export"] as const).map((k) => (
          <Link key={k} href={`/dashboard/assets?kind=${k}`} className={`rounded-full border px-3 py-1 ${kind === k ? "border-primary" : "border-border"}`}>
            {k}
          </Link>
        ))}
      </nav>

      {error ? (
        <p role="alert">Assets unavailable. Apply migration 00032.</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assets yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {assets.map((a) => (
            <li key={a.id} className="space-y-2 rounded-xl border border-border p-3 text-xs">
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted">
                {previews.has(a.id) ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
                  <img src={previews.get(a.id)} alt={a.file_name} className="h-full w-full object-cover" />
                ) : (
                  <span className="uppercase text-muted-foreground">{a.kind}</span>
                )}
              </div>
              <p className="truncate font-medium" title={a.file_name}>
                {a.file_name || a.kind}
              </p>
              <p className="text-muted-foreground">
                {size(Number(a.size_bytes))} · {a.status.replace("_", " ")}
                {a.retention_until && ` · expires ${new Date(a.retention_until).toLocaleDateString()}`}
              </p>
              <div className="flex flex-wrap gap-2">
                {a.status === "available" && (
                  <a className="underline" href={`/api/v1/assets/${a.id}/download`}>
                    Download
                  </a>
                )}
                {a.task_id && (
                  <Link className="underline" href={`/dashboard/jobs/${a.task_id}`}>
                    Job
                  </Link>
                )}
                {(role === "owner" || a.created_by === user.id) && (
                  <ActionButton url={`/api/v1/assets/${a.id}`} method="DELETE" label="Delete" variant="danger" confirm="Delete this asset permanently?" />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Result pages" className="flex items-center gap-4 text-sm">
        {page > 1 && (
          <Link className="underline" href={`?${new URLSearchParams({ page: String(page - 1), ...(kind ? { kind } : {}) })}`}>
            Previous
          </Link>
        )}
        <span>
          Page {page} · {count ?? 0} assets
        </span>
        {page * PAGE < (count ?? 0) && (
          <Link className="underline" href={`?${new URLSearchParams({ page: String(page + 1), ...(kind ? { kind } : {}) })}`}>
            Next
          </Link>
        )}
      </nav>
    </main>
  );
}
