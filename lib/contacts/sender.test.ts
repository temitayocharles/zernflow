import { describe, expect, it } from "vitest";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { upsertContactForSender } from "./sender";

const channel = { id: "ch-1", workspace_id: "ws-1" };
const base = { channel, senderId: "s-1", senderName: "Sam", senderPicture: null, interactionAt: "2026-09-25T10:00:00.000Z" };

describe("upsertContactForSender", () => {
  it("creates the contact, its channel mapping and a contact_created event for a new sender", async () => {
    const db = createMemorySupabase({ contact_channels: [], contacts: [], analytics_events: [] });
    const res = await upsertContactForSender({ supabase: db.client as never, ...base, senderUsername: "sam" });
    expect(res).toEqual({ contactId: expect.any(String), existed: false });
    expect(db.tables.contacts[0]).toMatchObject({ workspace_id: "ws-1", display_name: "Sam", last_interaction_at: base.interactionAt });
    expect(db.tables.contact_channels[0]).toMatchObject({ contact_id: res!.contactId, channel_id: "ch-1", platform_sender_id: "s-1", platform_username: "sam" });
    expect(db.tables.analytics_events[0]).toMatchObject({ event_type: "contact_created", contact_id: res!.contactId });
  });

  it("reuses a known sender and stamps last_interaction_at only when asked", async () => {
    const seed = () =>
      createMemorySupabase({
        contact_channels: [{ contact_id: "c-1", channel_id: "ch-1", platform_sender_id: "s-1" }],
        contacts: [{ id: "c-1", last_interaction_at: "old" }],
        analytics_events: [],
      });
    const stamped = seed();
    await expect(upsertContactForSender({ supabase: stamped.client as never, ...base })).resolves.toEqual({ contactId: "c-1", existed: true });
    expect(stamped.tables.contacts[0].last_interaction_at).toBe(base.interactionAt);
    expect(stamped.tables.analytics_events).toHaveLength(0);

    const untouched = seed();
    await upsertContactForSender({ supabase: untouched.client as never, ...base, stampExisting: false });
    expect(untouched.tables.contacts[0].last_interaction_at).toBe("old");
  });

  it("returns null when the contact insert fails, without orphan mappings", async () => {
    const db = createMemorySupabase({ contact_channels: [], contacts: [], analytics_events: [] });
    db.failNext("contacts", "insert");
    await expect(upsertContactForSender({ supabase: db.client as never, ...base })).resolves.toBeNull();
    expect(db.tables.contact_channels).toHaveLength(0);
  });
});
