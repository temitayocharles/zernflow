"use client";
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Adds the browser timezone to the URL once so server-rendered calendars group by local day. */
export function TimezoneSync({ current }: { current: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!current && tz) {
      const next = new URLSearchParams(params.toString());
      next.set("tz", tz);
      router.replace(`${pathname}?${next.toString()}`);
    }
  }, [current, params, pathname, router]);
  return null;
}
