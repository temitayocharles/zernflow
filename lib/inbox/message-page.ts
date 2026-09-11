import type { Database } from "@/lib/types/database";
type Message = Database["public"]["Tables"]["messages"]["Row"];
export interface MessagePage { messages: Message[]; nextCursor: string | null }
export function parseMessagePage(value: unknown): MessagePage {
  if (!value || typeof value !== "object" || !("messages" in value) || !("nextCursor" in value) ||
      !Array.isArray(value.messages) || (value.nextCursor !== null && typeof value.nextCursor !== "string")) {
    throw new Error("Invalid message page response");
  }
  for (const message of value.messages) {
    if (!message || typeof message !== "object" || typeof message.id !== "string" ||
        typeof message.conversation_id !== "string" || typeof message.created_at !== "string" ||
        !Number.isFinite(Date.parse(message.created_at))) throw new Error("Invalid message in page response");
  }
  return value as MessagePage;
}
/** Preserve already-loaded values on overlapping pages; stable chronological display. */
export function mergeMessagePages(current: readonly Message[], older: readonly Message[], conversationId: string): Message[] {
  const byId = new Map<string, Message>();
  for (const message of [...older, ...current]) {
    if (message.conversation_id !== conversationId) throw new Error("Message page belongs to a different conversation");
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
}
