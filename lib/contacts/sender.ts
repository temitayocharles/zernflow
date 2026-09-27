import type { SupabaseClient } from "@supabase/supabase-js";

// Provider-neutral: used by the Agent Social Gateway webhook processor and the
// legacy Zernio webhook. Moved out of lib/inbox-sync.ts (R8) when the unused
// Zernio inbox backfill was removed.

/**
 * Finds or creates the contact behind a platform sender: reuses the mapping in
 * `contact_channels` (channel_id, platform_sender_id); otherwise inserts the
 * contact, its channel mapping, and a `contact_created` analytics event.
 * Returns null when the contact insert fails; `existed` tells whether the
 * sender was already known on this channel.
 * With `stampExisting: false` an existing contact's last_interaction_at is
 * left untouched; the caller stamps it once the interaction is confirmed.
 */
export async function upsertContactForSender({
  supabase,
  channel,
  senderId,
  senderName,
  senderPicture,
  senderUsername,
  interactionAt,
  stampExisting = true,
}: {
  supabase: SupabaseClient;
  channel: { id: string; workspace_id: string };
  senderId: string;
  senderName: string;
  senderPicture: string | null;
  senderUsername?: string | null;
  interactionAt: string;
  stampExisting?: boolean;
}): Promise<{ contactId: string; existed: boolean } | null> {
  const { data: existingContactChannel } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", channel.id)
    .eq("platform_sender_id", senderId)
    .single();

  if (existingContactChannel) {
    if (stampExisting) {
      await supabase
        .from("contacts")
        .update({ last_interaction_at: interactionAt })
        .eq("id", existingContactChannel.contact_id);
    }
    return { contactId: existingContactChannel.contact_id, existed: true };
  }

  const { data: newContact } = await supabase
    .from("contacts")
    .insert({
      workspace_id: channel.workspace_id,
      display_name: senderName,
      avatar_url: senderPicture,
      last_interaction_at: interactionAt,
    })
    .select("id")
    .single();

  if (!newContact) return null;

  await supabase.from("contact_channels").insert({
    contact_id: newContact.id,
    channel_id: channel.id,
    platform_sender_id: senderId,
    platform_username: senderUsername ?? null,
  });

  await supabase.from("analytics_events").insert({
    workspace_id: channel.workspace_id,
    contact_id: newContact.id,
    event_type: "contact_created",
  });

  return { contactId: newContact.id, existed: false };
}
