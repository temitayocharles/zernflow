import { describe, expect, it } from "vitest";
import { mergeMessagePages, parseMessagePage } from "./message-page";
import type { Database } from "@/lib/types/database";
type Message = Database["public"]["Tables"]["messages"]["Row"];
function message(id: string, time: number, text = id): Message {
  return { id, conversation_id: "c", created_at: new Date(time).toISOString(), text } as Message;
}
describe("inbox message paging", () => {
  it("merges overlapping pages chronologically without replacing fresh values", () => {
    const recent = message("b", 2, "fresh");
    expect(mergeMessagePages([recent], [message("b", 2, "stale"), message("a", 1)], "c")).toEqual([message("a", 1), recent]);
  });
  it("rejects foreign-conversation pages", () => {
    expect(() => mergeMessagePages([], [message("a", 1)], "other")).toThrow("different conversation");
  });
  it("accepts empty final pages", () => {
    expect(parseMessagePage({ messages: [], nextCursor: null })).toEqual({ messages: [], nextCursor: null });
  });
  it.each([null, [], {}, { messages: [], nextCursor: 42 }, { messages: [null], nextCursor: null }, { messages: [{ id: "a", conversation_id: "c", created_at: "invalid" }], nextCursor: null }])("rejects malformed page %j", value => {
    expect(() => parseMessagePage(value)).toThrow();
  });
});
