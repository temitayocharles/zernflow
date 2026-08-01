"use client";

import { useState } from "react";
import {
  Settings,
  KeyRound,
  Hash,
  Save,
  Plus,
  X,
  Check,
  CircleAlert,
  Users,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface WorkspaceSettings {
  id: string;
  name: string;
  gatewayDriver: "agent" | "zernio";
  gatewayConfigured: boolean;
  aiConfigured: boolean;
  globalKeywords: string[];
}

function ManagedSecretStatus({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center gap-1 text-xs text-green-600">
      <Check className="h-3.5 w-3.5" />
      Configured by the runtime secret manager
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-amber-600">
      <CircleAlert className="h-3.5 w-3.5" />
      Not configured in the deployment environment
    </span>
  );
}

export function SettingsView({ workspace }: { workspace: WorkspaceSettings }) {
  const [name, setName] = useState(workspace.name);
  const [keywords, setKeywords] = useState<string[]>(workspace.globalKeywords);
  const [newKeyword, setNewKeyword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addKeyword() {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed) return;
    if (!keywords.includes(trimmed)) setKeywords((prev) => [...prev, trimmed]);
    setNewKeyword("");
  }

  function removeKeyword(keyword: string) {
    setKeywords((prev) => prev.filter((item) => item !== keyword));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("workspaces")
        .update({ name: name.trim(), global_keywords: keywords })
        .eq("id", workspace.id)
        .select("id")
        .single();

      if (updateError) throw new Error(updateError.message);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage workspace behavior and deployment status</p>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl space-y-8 px-8 py-8">
          <section>
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">General</h2>
            </div>
            <div className="mt-4">
              <label className="text-xs font-medium text-muted-foreground">Workspace Name</label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Social Gateway</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Driver: <span className="font-medium text-foreground">{workspace.gatewayDriver === "agent" ? "Self-hosted Agent Social Gateway" : "Hosted compatibility adapter"}</span>
            </p>
            <div className="mt-3"><ManagedSecretStatus configured={workspace.gatewayConfigured} /></div>
            <p className="mt-2 text-xs text-muted-foreground">
              Provider credentials and gateway API keys are managed in Vault and injected at runtime. They are never stored in workspace rows or exposed in this interface.
            </p>
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">AI Runtime</h2>
            </div>
            <div className="mt-3"><ManagedSecretStatus configured={workspace.aiConfigured} /></div>
            <p className="mt-2 text-xs text-muted-foreground">
              The AI key is injected through <code className="rounded bg-muted px-1 py-0.5">AI_GATEWAY_API_KEY</code>; operators cannot read or replace it from the browser.
            </p>
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Global Keywords</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Keywords that trigger flows across all channels.</p>
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                value={newKeyword}
                onChange={(event) => setNewKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="Add a keyword..."
                className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={addKeyword}
                disabled={!newKeyword.trim()}
                className="rounded-lg bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {keywords.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {keywords.map((keyword) => (
                  <span key={keyword} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium">
                    {keyword}
                    <button onClick={() => removeKeyword(keyword)} className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground/70">No global keywords configured</p>
            )}
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Team</h2>
            </div>
            <Link href="/dashboard/settings/team" className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted">
              <Users className="h-4 w-4" />
              Manage Team
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          </section>

          <hr className="border-border" />

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : "Save Changes"}
            </button>
            {saved && <span className="flex items-center gap-1 text-sm text-green-600"><Check className="h-4 w-4" />Settings saved</span>}
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
