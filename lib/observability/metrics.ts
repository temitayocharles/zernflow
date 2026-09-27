/**
 * In-process metrics seam ($0: no exporter required). Counters and summaries
 * are exposed through /api/v1/system/health; an exporter can read snapshot().
 */
type Labels = Record<string, string | number | boolean | undefined>;

const counters = new Map<string, number>();
const summaries = new Map<string, { count: number; sum: number; max: number }>();

function key(name: string, labels: Labels = {}): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

export function increment(name: string, labels?: Labels, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function observe(name: string, value: number, labels?: Labels): void {
  const k = key(name, labels);
  const current = summaries.get(k) ?? { count: 0, sum: 0, max: 0 };
  current.count += 1;
  current.sum += value;
  current.max = Math.max(current.max, value);
  summaries.set(k, current);
}

export function snapshot() {
  return {
    counters: Object.fromEntries(counters),
    summaries: Object.fromEntries(summaries),
  };
}

export function resetMetrics(): void {
  counters.clear();
  summaries.clear();
}
