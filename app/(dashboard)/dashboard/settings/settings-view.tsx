"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Hash,
  Plus,
  Save,
  Server,
  Settings,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface WorkspaceSettings {
  id: string;
  name: string;
  globalKeywords: string[];
  canManageSettings: boolean;
  gatewayConfigured: boolean;
  aiConfigured: boolean;
}

function IntegrationStatus({
  configured,
  configuredText,
  missingText,
}: {
  configured: boolean;
  configuredText: string;
  missingText: string;
}) {
  return configured ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {configuredText}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-amber-600">
      <AlertTriangle className="h-3.5 w-3.5" />
      {missingText}
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
    if (!workspace.canManageSettings) return;
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || keywords.includes(trimmed)) {
      setNewKeyword("");
      return;
    }
    setKeywords((previous) => [...previous, trimmed]);
    setNewKeyword("");
  }

  function removeKeyword(keyword: string) {
    if (!workspace.canManageSettings) return;
    setKeywords((previous) => previous.filter((item) => item !== keyword));
  }

  async function handleSave() {
    if (saving || !workspace.canManageSettings) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("workspaces")
        .update({
          name: name.trim(),
          global_keywords: keywords,
        })
        .eq("id", workspace.id)
        .select("id")
        .single();

      if (updateError) throw new Error(updateError.message);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage workspace preferences and review deployment integrations
        </p>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl space-y-8 px-8 py-8">
          {!workspace.canManageSettings && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
              Only workspace owners can change workspace configuration.
            </div>
          )}

          <section>
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">General</h2>
            </div>
            <div className="mt-4">
              <label className="text-xs font-medium text-muted-foreground">
                Workspace Name
              </label>
              <input
                type="text"
                value={name}
                disabled={!workspace.canManageSettings}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Agent Social Gateway</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Provider accounts, messages, approvals, assignments and human takeover use a
              server-only gateway connection. Credentials are injected by the deployment and
              are never stored in browser-accessible workspace rows.
            </p>
            <div className="mt-3">
              <IntegrationStatus
                configured={workspace.gatewayConfigured}
                configuredText="Server-side gateway connection configured"
                missingText="Provider connectivity is disabled until the deployment is configured"
              />
            </div>
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">AI Gateway</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              AI provider credentials are managed through the deployment secret manager, not
              through the workspace UI.
            </p>
            <div className="mt-3">
              <IntegrationStatus
                configured={workspace.aiConfigured}
                configuredText="Server-side AI gateway connection configured"
                missingText="AI response nodes are disabled until a server-side key is configured"
              />
            </div>
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Global Keywords</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Keywords that trigger flows across all channels. Flow-specific triggers take
              priority over global keywords.
            </p>

            <div className="mt-4 flex gap-2">
              <input
                type="text"
                value={newKeyword}
                disabled={!workspace.canManageSettings}
                onChange={(event) => setNewKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="Add a keyword..."
                className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                onClick={addKeyword}
                disabled={!workspace.canManageSettings || !newKeyword.trim()}
                className="rounded-lg bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            {keywords.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {keywords.map((keyword) => (
                  <span
                    key={keyword}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium"
                  >
                    {keyword}
                    {workspace.canManageSettings && (
                      <button
                        onClick={() => removeKeyword(keyword)}
                        className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground/70">
                No global keywords configured
              </p>
            )}
          </section>

          <hr className="border-border" />

          <section>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Team</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Manage workspace members and invitations.
            </p>
            <Link
              href="/dashboard/settings/team"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Users className="h-4 w-4" />
              Manage Team
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          </section>

          {workspace.canManageSettings && (
            <>
              <hr className="border-border" />
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={saving || !name.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Changes
                    </>
                  )}
                </button>

                {saved && (
                  <span className="flex items-center gap-1 text-sm text-green-600">
                    <Check className="h-4 w-4" />
                    Settings saved
                  </span>
                )}
                {error && <span className="text-sm text-red-600">{error}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
