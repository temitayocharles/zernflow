"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Shared JSON submit with accessible error state and a server refresh. */
export function useJsonSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit<T = Record<string, unknown>>(url: string, method: "POST" | "PATCH", body: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof data.error === "string" ? data.error : `Request failed (${r.status})`);
        return data as T;
      }
      router.refresh();
      return data as T;
    } catch {
      setError("Network error; try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, submit, router };
}

export const inputClass = "mt-1 w-full rounded border border-border bg-background p-2 text-sm";

/** Converts a datetime-local value (browser local time) to ISO, or null. */
export function localToIso(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToLocal(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
