"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf,text/csv,application/json,text/plain";

function kindFor(type: string): string {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "document";
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Direct-to-storage upload: the app never proxies bytes. The browser hashes the
 * file, receives a presigned PUT bound to type/size/checksum, uploads, then asks
 * the server to verify the object.
 */
export function AssetUpload({ disabled, maxBytes }: { disabled?: boolean; maxBytes: number }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > maxBytes) return setStatus(`${file.name} exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`);
    setBusy(true);
    try {
      setStatus(`Hashing ${file.name}…`);
      const sha256 = await sha256Hex(file);
      const created = await fetch("/api/v1/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size, sha256, kind: kindFor(file.type) }),
      });
      const data = await created.json().catch(() => ({}));
      if (!created.ok) return setStatus(data.error ?? "Upload refused");
      setStatus(`Uploading ${file.name}…`);
      const put = await fetch(data.upload.url, { method: "PUT", headers: data.upload.headers, body: file });
      if (!put.ok) return setStatus(`Storage rejected the upload (HTTP ${put.status}). Check bucket CORS for this origin.`);
      setStatus("Verifying…");
      const done = await fetch(`/api/v1/assets/${data.artifact.id}/complete`, { method: "POST" });
      const result = await done.json().catch(() => ({}));
      setStatus(done.ok ? `${file.name} uploaded.` : result.asset?.status === "quarantined" ? `${file.name} failed verification and was quarantined.` : result.error ?? "Verification failed");
      router.refresh();
    } catch {
      setStatus("Upload failed. Check your connection and storage CORS settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border p-4">
      <label className="text-sm">
        <span className="sr-only">Upload asset</span>
        <input
          type="file"
          accept={ACCEPT}
          disabled={disabled || busy}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void upload(file);
          }}
          className="text-sm"
        />
      </label>
      <span role="status" className="text-xs text-muted-foreground">
        {status}
      </span>
    </div>
  );
}
