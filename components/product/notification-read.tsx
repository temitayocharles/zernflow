"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function NotificationRead({ id }: { id: string }) {
  const [state, setState] = useState("");
  const router = useRouter();
  return (
    <span>
      <button
        disabled={state === "Saving…"}
        className="text-xs underline disabled:opacity-50"
        onClick={async () => {
          setState("Saving…");
          try {
            const r = await fetch(`/api/v1/notifications/${id}`, {
              method: "PATCH",
            });
            if (!r.ok) throw new Error("Unable to mark read");
            setState("");
            router.refresh();
          } catch {
            setState("Unable to mark read. Retry.");
          }
        }}
      >
        Mark read
      </button>
      <span role="status" className="ml-2 text-xs">
        {state}
      </span>
    </span>
  );
}
