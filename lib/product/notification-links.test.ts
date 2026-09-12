import { describe, expect, it } from "vitest";
import { notificationLink } from "./notification-links";
const id = "00000000-0000-4000-8000-000000000001";
describe("notification links", () => {
  it("links only supported local entities", () => {
    expect(notificationLink("work_items", id)).toBe(
      `/dashboard/work-items/${id}`,
    );
    expect(notificationLink("conversations", id)).toContain(
      "/dashboard/inbox?conversationId=",
    );
    expect(notificationLink("toString", id)).toBeNull();
    expect(notificationLink("https://attacker.example", id)).toBeNull();
  });
  it("rejects malformed entity IDs", () =>
    expect(notificationLink("work_items", "../../outside")).toBeNull());
});
