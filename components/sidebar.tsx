"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { LogOut, Moon, Sun } from "lucide-react";
import { activeHref, NAVIGATION } from "@/components/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

/** Only browser-safe identity fields are ever passed to this client component. */
type Workspace = { id: string; name: string; slug: string };

interface WorkspaceItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

function subscribeToThemeClass(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
  return () => observer.disconnect();
}


export function Sidebar({
  workspace,
  workspaces,
  role,
}: {
  role?: string;
  workspace: Workspace;
  user: { id: string; email?: string };
  workspaces: WorkspaceItem[];
}) {
  const pathname = usePathname();
  const current = activeHref(pathname);
  const router = useRouter();
  const supabase = createClient();
  const dark = useSyncExternalStore(
    subscribeToThemeClass,
    () => document.documentElement.classList.contains("dark"),
    () => false
  );

  function toggleTheme() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex h-full w-60 flex-col border-r border-border bg-sidebar">
      <div className="border-b border-sidebar-border px-3 py-3">
        <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {NAVIGATION.map((group) => {
          const items = group.items.filter((i) => !i.ownerOnly || role === "owner");
          if (!items.length) return null;
          return (
            <div key={group.label ?? "home"} className="space-y-1">
              {group.label && (
                <p className="px-3 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/50">{group.label}</p>
              )}
              {items.map((item) => {
                const isActive = item.href === current;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3 space-y-1">
        <button
          onClick={toggleTheme}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {dark ? "Light mode" : "Dark mode"}
        </button>
        <button
          onClick={handleSignOut}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}
