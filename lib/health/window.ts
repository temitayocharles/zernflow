/** Time helpers for server components (kept out of render bodies for react-hooks/purity). */
export function upcomingWindow(days: number): { now: string; until: string } {
  const now = Date.now();
  return { now: new Date(now).toISOString(), until: new Date(now + days * 86_400_000).toISOString() };
}
