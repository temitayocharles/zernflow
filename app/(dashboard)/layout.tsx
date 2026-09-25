import { getWorkspace } from "@/lib/workspace";
import { DashboardNavigation } from "@/components/dashboard-navigation";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { workspace, user, supabase, role } = await getWorkspace();

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("role, workspaces(id, name, slug)")
    .eq("user_id", user.id);

  const workspaces = (memberships ?? [])
    .map((m) => ({
      ...(m.workspaces as { id: string; name: string; slug: string }),
      role: m.role,
    }))
    .filter((w) => w.id);

  return (
    <div className="flex h-screen">
      <DashboardNavigation
        workspace={{ id: workspace.id, name: workspace.name, slug: workspace.slug }}
        user={{ id: user.id, email: user.email }}
        workspaces={workspaces}
        role={role}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-auto pt-14 md:pt-0">{children}</main>
    </div>
  );
}
