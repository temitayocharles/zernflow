"use client";
import {CollaborationControls} from "@/components/product/collaboration-controls";
import {Activity} from "@/components/product/activity";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, RefreshCw, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { CreateWorkItem } from "@/components/product/create-work-item";
import { ContactPanel } from "@/components/inbox/contact-panel";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/types/database";
import { mergeMessagePages, parseMessagePage } from "@/lib/inbox/message-page";
import { cn } from "@/lib/utils";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"] | null;
};
type Message = Database["public"]["Tables"]["messages"]["Row"];

export function InboxView({
  conversations,
  workspaceId,
  initialConversationId,
  isOwner,
}: {
  conversations: Conversation[];
  workspaceId: string;
  initialConversationId?:string;
  isOwner:boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Conversation | null>(conversations.find(c=>c.id===initialConversationId)??null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const olderController = useRef<AbortController | null>(null);
  const [reload, setReload] = useState(0);
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
    if (selected?.id === conversation.id) return;
    olderController.current?.abort();
    setNextCursor(null);
    setLoadingMessages(true);
    setMessages([]);
    setMessageError(null);
    setSelected(conversation);
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    const conversation = selected;
    const controller = new AbortController();
    olderController.current?.abort();
    setLoadingOlder(false);
    setOlderError(null);
    setNextCursor(null);
    async function loadMessages() {
      setLoadingMessages(true);
      setMessageError(null);
      setMessages([]);
      try {
        const response = await fetch(
          `/api/v1/messages?conversationId=${encodeURIComponent(conversation.id)}&paginated=true&limit=50`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Unable to load messages. Retry or check the Gateway connection.");
        const data = parseMessagePage(await response.json());
        if (controller.signal.aborted) return;
        setMessages(mergeMessagePages([], data.messages, conversation.id));
        setNextCursor(data.nextCursor);
        // Do not clear unread state when delivery failed, selection changed, or
        // a newer event changed the observed count while this read was in flight.
        if (conversation.unread_count > 0) {
          const { error } = await createClient().from("conversations")
            .update({ unread_count: 0 })
            .eq("id", conversation.id)
            .eq("workspace_id", workspaceId)
            .eq("unread_count", conversation.unread_count);
          if (error && !controller.signal.aborted) setMessageError("Messages loaded, but marking the conversation read failed. Retry to update unread state.");
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessageError(error instanceof Error ? error.message : "Unable to load messages.");
      } finally {
        if (!controller.signal.aborted) setLoadingMessages(false);
      }
    }
    void loadMessages();
    return () => { controller.abort(); olderController.current?.abort(); };
  }, [selected, workspaceId, reload]);

  async function loadOlderMessages() {
    if (!selected || !nextCursor || loadingOlder) return;
    const conversationId = selected.id;
    const cursor = nextCursor;
    const controller = new AbortController();
    olderController.current?.abort();
    olderController.current = controller;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const params = new URLSearchParams({ conversationId, cursor, paginated: "true", limit: "50" });
      const response = await fetch(`/api/v1/messages?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Unable to load older messages. Please retry.");
      const page = parseMessagePage(await response.json());
      if (controller.signal.aborted) return;
      if (page.nextCursor === cursor) throw new Error("Gateway pagination did not advance. Retry later.");
      // Validate the page before scheduling a state update (React updater
      // exceptions are not caught by this async function).
      const older = mergeMessagePages([], page.messages, conversationId);
      setMessages(current => mergeMessagePages(current, older, conversationId));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted) setOlderError(error instanceof Error ? error.message : "Unable to load older messages.");
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

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
        {selected && <div className="border-b border-border p-2"><CreateWorkItem conversationId={selected.id} contactId={selected.contact_id}/><CollaborationControls key={selected.id} id={selected.id} isOwner={isOwner}/><details className="mt-2 text-xs"><summary>Internal notes & activity</summary><div className="max-h-72 overflow-auto"><Activity key={selected.id} kind="conversations" id={selected.id}/></div></details></div>}
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
        {selected && nextCursor && !loadingMessages && !messageError && (
          <div className="border-b border-border px-4 py-2 text-center">
            <button onClick={loadOlderMessages} disabled={loadingOlder} className="rounded-md px-3 py-1 text-sm hover:bg-muted disabled:opacity-50">
              {loadingOlder ? "Loading older messages…" : "Load older messages"}
            </button>
            {olderError && <p role="alert" className="mt-1 text-xs text-destructive">{olderError}</p>}
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
          ) : messageError ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-destructive">{messageError}</p>
              <button onClick={() => setReload(value => value + 1)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted">Retry loading messages</button>
            </div>
          ) : loadingMessages && selected ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : (
            <MessageThread key={selected?.id ?? "empty"} conversation={selected} messages={messages} />
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
