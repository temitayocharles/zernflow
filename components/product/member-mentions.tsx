"use client";
import { useEffect, useState } from "react";
export function MemberMentions() {
  const [members, setMembers] = useState<
    { user_id: string; display_name: string; role: string }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/product/members", { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (!controller.signal.aborted) setMembers(data.members);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Team directory unavailable; note can still be saved without mentions.",
          );
      });
    return () => controller.abort();
  }, []);
  return (
    <label className="block text-sm">
      Mention teammates (select up to 20; directory capped at 500)
      <select
        name="mentions"
        multiple
        size={Math.min(4, Math.max(2, members.length))}
        className="my-2 w-full rounded border border-border bg-background p-2"
      >
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {m.display_name} ({m.role}) · {m.user_id.slice(0, 8)}
          </option>
        ))}
      </select>
      {error && (
        <span role="status" className="text-xs text-muted-foreground">
          {error}
        </span>
      )}
    </label>
  );
}
