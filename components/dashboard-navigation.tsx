"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
type Props = React.ComponentProps<typeof Sidebar>;
export function DashboardNavigation(props: Props) {
  const [openForPath, setOpenForPath] = useState<string | null>(null);
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const open = openForPath === pathname;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <>
      <div className="hidden h-full shrink-0 md:block">
        <Sidebar {...props} />
      </div>
      <div className="fixed left-3 top-3 z-40 md:hidden">
        <button
          aria-label="Open workspace navigation"
          aria-expanded={open}
          onClick={() => setOpenForPath(pathname)}
          className="rounded-lg border border-border bg-background p-2"
        >
          <Menu size={20} />
        </button>
      </div>
      <dialog
        ref={dialog}
        aria-label="Workspace navigation"
        onClose={() => setOpenForPath(null)}
        className="m-0 h-dvh max-h-none w-60 max-w-none border-0 bg-background p-0 text-foreground backdrop:bg-black/40 md:hidden"
      >
        <button
          autoFocus
          onClick={() => dialog.current?.close()}
          aria-label="Close workspace navigation"
          className="absolute right-2 top-2 z-10 rounded bg-background p-2"
        >
          <X size={18} />
        </button>
        <div className="h-full pt-10">
          <Sidebar {...props} />
        </div>
      </dialog>
    </>
  );
}
