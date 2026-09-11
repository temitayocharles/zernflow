import { describe, expect, it } from "vitest";
import { parseMessageQuery } from "./message-query";
describe("message query", () => {
  it("keeps existing array response callers compatible", () => {
    expect(parseMessageQuery(new URLSearchParams("conversationId=c"))).toEqual({ conversationId: "c", limit: 200, cursor: undefined, paginated: false });
  });
  it("supports bounded provider-neutral cursor pages", () => {
    expect(parseMessageQuery(new URLSearchParams("conversationId=c&limit=50&cursor=opaque&paginated=true"))).toEqual({ conversationId: "c", limit: 50, cursor: "opaque", paginated: true });
  });
  it.each(["", "conversationId=", "conversationId=c&limit=0", "conversationId=c&limit=201", "conversationId=c&limit=1.5", "conversationId=c&limit=NaN", "conversationId=c&cursor=", `conversationId=c&cursor=${"x".repeat(2049)}`])("rejects invalid query %s", query => {
    expect(() => parseMessageQuery(new URLSearchParams(query))).toThrow();
  });
});
