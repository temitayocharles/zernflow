// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Database } from "@/lib/types/database";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/inbox/contact-panel", () => ({
  ContactPanel: () => null,
}));
vi.mock("@/components/product/create-work-item", () => ({
  CreateWorkItem: () => null,
}));
vi.mock("@/components/product/collaboration-controls", () => ({
  CollaborationControls: () => null,
}));
vi.mock("@/components/product/activity", () => ({ Activity: () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }),
      }),
    }),
  }),
}));
type Conversation = Database["public"]["Tables"]["conversations"]["Row"] & {
  contacts: null;
};
vi.mock("@/components/inbox/conversation-list", () => ({
  ConversationList: ({
    conversations,
    onSelect,
  }: {
    conversations: Conversation[];
    onSelect: (c: Conversation) => void;
  }) => (
    <div>
      {conversations.map((c) => (
        <button key={c.id} onClick={() => onSelect(c)}>
          Select {c.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@/components/inbox/message-thread", () => ({
  MessageThread: ({
    messages,
  }: {
    messages: { id: string; text: string }[];
  }) => (
    <div data-testid="thread">
      {messages.map((m) => (
        <p key={m.id}>{m.text}</p>
      ))}
    </div>
  ),
}));
import { InboxView } from "./inbox-view";
const conversations = ["old", "new"].map(
  (id) =>
    ({
      id,
      workspace_id: "w",
      channel_id: "ch",
      contact_id: "contact",
      late_conversation_id: "remote",
      platform: "telegram",
      status: "open",
      assigned_to: null,
      last_message_at: null,
      last_message_preview: null,
      unread_count: 0,
      is_automation_paused: false,
      created_at: "2026-09-11T00:00:00Z",
      updated_at: "2026-09-11T00:00:00Z",
      contacts: null,
    }) as Conversation,
);
const msg = (id: string, conversation_id: string, text: string, time = 0) => ({
  id,
  conversation_id,
  text,
  created_at: new Date(time).toISOString(),
});
const page = (messages: unknown[], nextCursor: string | null = null) =>
  new Response(JSON.stringify({ messages, nextCursor }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("inbox request races and history paging", () => {
  it("ignores an old response arriving after selection changes", async () => {
    let finishOld!: (r: Response) => void;
    const old = new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(
        page([msg("n", "new", "New conversation message")]),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      <InboxView
        conversations={conversations}
        workspaceId="w"
        isOwner={false}
      />,
    );
    fireEvent.click(screen.getByText("Select old"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Select new"));
    await screen.findByText("New conversation message");
    await act(async () => {
      finishOld(page([msg("o", "old", "Stale conversation message")]));
      await old;
    });
    expect(screen.queryByText("Stale conversation message")).toBeNull();
    expect(screen.getByText("New conversation message")).toBeTruthy();
  });
  it("preserves current messages while older pages deduplicate", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([msg("b", "new", "Recent", 2)], "older"))
      .mockResolvedValueOnce(
        page([msg("a", "new", "Older", 1), msg("b", "new", "Stale copy", 2)]),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      <InboxView
        conversations={conversations}
        workspaceId="w"
        isOwner={false}
        initialConversationId="new"
      />,
    );
    await screen.findByText("Recent");
    fireEvent.click(screen.getByText("Load older messages"));
    await screen.findByText("Older");
    expect(screen.getByTestId("thread").textContent).toBe("OlderRecent");
    expect(screen.queryByText("Stale copy")).toBeNull();
  });
  it("surfaces retry instead of pretending a failed read is an empty thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(page([msg("m", "new", "Recovered")])),
    );
    render(
      <InboxView
        conversations={conversations}
        workspaceId="w"
        isOwner={false}
        initialConversationId="new"
      />,
    );
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Retry loading messages"));
    await screen.findByText("Recovered");
  });
});
