"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const input = "rounded-lg border border-border bg-background px-2 py-1 text-sm";

/** Creates a lead-intake token; the plaintext is shown once and never retrievable again. */
export function CreateIntakeTokenForm({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [token, setToken] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const formEl = event.currentTarget;
          const form = new FormData(formEl);
          setToken(null);
          const res = await fetch("/api/v1/lead-intake", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: form.get("name"), defaultCampaignId: form.get("defaultCampaignId") || null }),
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string; token?: string };
          if (!res.ok || !data.token) return setStatus(data.error ?? "Unable to create token");
          formEl.reset();
          setToken(data.token);
          setStatus("");
          router.refresh();
        }}
      >
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Name</span>
          <input name="name" required maxLength={120} placeholder="Website contact form" className={input} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Default campaign (optional)</span>
          <select name="defaultCampaignId" className={input} defaultValue="">
            <option value="">Match by utm_campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-accent">Create token</button>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </form>
      {token && (
        <div role="alert" className="space-y-1 rounded-lg border border-amber-500/50 p-3 text-sm">
          <p>Copy this token now. It is not shown again. Keep it on your server; never put it in public page code.</p>
          <code className="block break-all rounded bg-muted p-2 text-xs">{token}</code>
        </div>
      )}
    </div>
  );
}
