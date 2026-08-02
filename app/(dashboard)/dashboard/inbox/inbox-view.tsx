"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, RefreshCw, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { ContactPanel } from "@/components/inbox/contact-panel";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/types/database";
import { cn } from "@/lib/utils";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"] | null;
};
type Message = Database["public"]["Tables"]["messages"]["Row"];

export function InboxView({
  conversations,
  workspaceId,
}: {
  conversations: Conversation[];
  workspaceId: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showContactPanel, setShowContactPanel] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Refresh the local channel projection from Agent Social Gateway. Conversation
  // import and realtime delivery are separate migration slices.
  async function handleSyncAccounts() {
    setSyncing(true);
    setSyncError(null);
    try {
      const response = await fetch("/api/v1/channels/sync", { method: "POST" });
      const data = await response.json();
      if (!response.ok || data.error) {
        setSyncError(data.error || "Account synchronization failed");
        return;
      }
      router.refresh();
    } catch {
      setSyncError("Failed to synchronize accounts. Check the gateway connection.");
    } finally {
      setSyncing(false);
    }
  }

  const handleSelect = useCallback((conversation: Conversation) => {
    setSelected(conversation);
  }, []);

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }

    async function loadMessages() {
      setLoadingMessages(true);
      try {
        const response = await fetch(
          `/api/v1/messages?conversationId=${selected!.id}`,
        );
        if (response.ok) {
          const data = await response.json();
          setMessages(data ?? []);
        } else {
          console.error("Failed to load messages:", response.status);
          setMessages([]);
        }
      } catch (error) {
        console.error("Failed to load messages:", error);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }

      if (selected!.unread_count > 0) {
        const supabase = createClient();
        await supabase
          .from("conversations")
          .update({ unread_count: 0 })
          .eq("id", selected!.id);
      }
    }

    loadMessages();
  }, [selected?.id]);

  return (
    <div className="flex h-full">
      <div className="w-80 flex-shrink-0">
        <ConversationList
          conversations={conversations}
          workspaceId={workspaceId}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {selected && !showContactPanel && (
          <div className="flex shrink-0 justify-end border-b border-border px-2 py-1">
            <button
              onClick={() => setShowContactPanel(true)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Show contact info"
            >
              <User className="h-3.5 w-3.5" />
              Contact info
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {conversations.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <MessageSquare className="h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No conversations yet
              </p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">
                Synchronize connected accounts from Agent Social Gateway. Verified inbound
                messages will appear here as the conversation delivery slice is enabled.
              </p>
              <button
                onClick={handleSyncAccounts}
                disabled={syncing}
                className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
                {syncing ? "Synchronizing..." : "Sync connected accounts"}
              </button>
              {syncError && (
                <p className="mt-2 text-xs text-destructive">{syncError}</p>
              )}
            </div>
          ) : loadingMessages && selected ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : (
            <MessageThread conversation={selected} messages={messages} />
          )}
        </div>
      </div>

      {showContactPanel && selected?.contact_id && (
        <ContactPanel
          contactId={selected.contact_id}
          workspaceId={workspaceId}
          onClose={() => setShowContactPanel(false)}
        />
      )}
    </div>
  );
}
