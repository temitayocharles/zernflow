import { getWorkspace } from "@/lib/workspace";
import { InboxView } from "./inbox-view";

export default async function InboxPage({searchParams}:{searchParams:Promise<{conversationId?:string}>}) {
  const requested=(await searchParams).conversationId;
  const { workspace, supabase, role } = await getWorkspace();

  const { data: conversations } = await supabase
    .from("conversations")
    .select("*, contacts(*)")
    .eq("workspace_id", workspace.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const items=conversations??[];
  if(requested && !items.some(c=>c.id===requested)){
    const {data}=await supabase.from("conversations").select("*, contacts(*)").eq("workspace_id",workspace.id).eq("id",requested).maybeSingle();
    if(data)items.unshift(data);
  }
  return (
    <InboxView
      conversations={items}
      initialConversationId={requested}
      isOwner={role==="owner"}
      workspaceId={workspace.id}
    />
  );
}
