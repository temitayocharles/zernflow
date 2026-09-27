/**
 * In-process fixed-window limiter. Adequate for the single always-on app
 * instance of the zero-cost deployment; a multi-instance deployment gets a
 * per-instance limit (documented), never a paid shared store by default.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Returns 0 when allowed, otherwise milliseconds until the window resets. */
  take(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }
    if (w.count >= this.limit) return this.windowMs - (now - w.start);
    w.count++;
    return 0;
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
