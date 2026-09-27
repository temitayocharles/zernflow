import { randomUUID } from "node:crypto";

/**
 * Minimal in-memory stand-in for the supabase-js query builder, for unit
 * tests of server stores. Supports the subset used by lib/* stores:
 * select (column projection), insert, update, delete, eq/neq/in/is/lt/lte/
 * gt/gte filters, order, limit, single/maybeSingle, and rpc via handlers.
 * Constraint checks are supplied per table so tests can model unique indexes.
 * SQL semantics (RLS, triggers) are covered by the PGlite suites instead.
 */
type Row = Record<string, unknown>;
type Err = { code: string; message: string } | null;
type Result = { data: unknown; error: Err; count?: number | null };

export interface MemoryOptions {
  constraints?: Record<string, (row: Row, rows: Row[]) => string | null>;
  rpc?: Record<string, (args: Record<string, unknown>, db: MemoryDb) => unknown>;
  defaults?: Record<string, () => Row>;
}

export interface MemoryDb {
  tables: Record<string, Row[]>;
  client: unknown;
  failNext(table: string, op: "insert" | "update" | "delete" | "select", code?: string): void;
}

export function createMemorySupabase(seed: Record<string, Row[]> = {}, opts: MemoryOptions = {}): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const failures: Array<{ table: string; op: string; code: string }> = [];

  const db: MemoryDb = {
    tables,
    client: null,
    failNext(table, op, code = "XX000") {
      failures.push({ table, op, code });
    },
  };

  function takeFailure(table: string, op: string): Err {
    const i = failures.findIndex((f) => f.table === table && f.op === op);
    if (i < 0) return null;
    const [f] = failures.splice(i, 1);
    return { code: f.code, message: "injected failure" };
  }

  function builder(table: string) {
    tables[table] ??= [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let columns: string | null = null;
    let returning = false;
    let countMode = false;
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    let mode: "many" | "single" | "maybe" = "many";
    let ignoreDuplicates = false;

    const project = (r: Row): Row => {
      if (!columns || columns.trim() === "*") return { ...r };
      const tokens = columns.split(",").map((s) => s.trim()).filter(Boolean);
      // "*, rel(cols)" embeds are not modelled: tests seed the embedded object
      // on the row itself, so a wildcard returns the whole row.
      if (tokens.includes("*")) return { ...r };
      const out: Row = {};
      for (const c of tokens) out[c] = r[c];
      return out;
    };

    const matches = (r: Row) => filters.every((f) => f(r));

    function execute(): Result {
      const injected = takeFailure(table, op);
      if (injected) return { data: null, error: injected };
      const rows = tables[table];
      let affected: Row[] = [];
      if (op === "insert") {
        for (const p of payload) {
          const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...(opts.defaults?.[table]?.() ?? {}), ...p };
          const violation = opts.constraints?.[table]?.(row, rows);
          if (violation && ignoreDuplicates && violation === "23505") continue;
          if (violation) return { data: null, error: { code: violation, message: "constraint" } };
          rows.push(row);
          affected.push(row);
        }
      } else if (op === "update") {
        for (const r of rows.filter(matches)) {
          const next = { ...r, ...patch };
          const violation = opts.constraints?.[table]?.(next, rows.filter((x) => x !== r));
          if (violation) return { data: null, error: { code: violation, message: "constraint" } };
          Object.assign(r, patch);
          affected.push(r);
        }
      } else if (op === "delete") {
        affected = rows.filter(matches);
        tables[table] = rows.filter((r) => !matches(r));
      } else {
        affected = rows.filter(matches);
      }
      const total = affected.length;
      if (orderBy) {
        const { col, asc } = orderBy;
        affected = [...affected].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (range) affected = affected.slice(range[0], range[1] + 1);
      if (limitN !== null) affected = affected.slice(0, limitN);
      const wantRows = op === "select" || returning;
      const data = wantRows ? affected.map(project) : null;
      if (mode === "single") {
        if (!data || data.length !== 1) return { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
        return { data: data[0], error: null };
      }
      if (mode === "maybe") {
        if (data && data.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: data?.[0] ?? null, error: null };
      }
      return { data, error: null, count: countMode ? total : null };
    }

    const api = {
      select(cols?: string, o?: { count?: string; head?: boolean }) {
        columns = cols ?? "*";
        if (op !== "select") returning = true;
        if (o?.count) countMode = true;
        return api;
      },
      insert(rows: Row | Row[]) {
        op = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        return api;
      },
      upsert(rows: Row | Row[], o?: { ignoreDuplicates?: boolean }) {
        op = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        ignoreDuplicates = Boolean(o?.ignoreDuplicates);
        return api;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return api;
      },
      neq(c: string, v: unknown) {
        filters.push((r) => r[c] !== v);
        return api;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return api;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v);
        return api;
      },
      contains(c: string, v: Record<string, unknown>) {
        // Shallow jsonb @> for object values (the subset used by stores).
        filters.push((r) => {
          const col = r[c];
          if (!col || typeof col !== "object") return false;
          return Object.entries(v).every(([k, want]) => (col as Row)[k] === want);
        });
        return api;
      },
      ilike(c: string, pattern: string) {
        // SQL LIKE semantics: % and _ wildcards, backslash escapes, case-insensitive.
        let re = "";
        for (let i = 0; i < pattern.length; i++) {
          const ch = pattern[i];
          if (ch === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          else if (ch === "%") re += ".*";
          else if (ch === "_") re += ".";
          else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        const rx = new RegExp(`^${re}$`, "is");
        filters.push((r) => typeof r[c] === "string" && rx.test(r[c] as string));
        return api;
      },
      lt(c: string, v: unknown) {
        filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as number) < (v as number));
        return api;
      },
      lte(c: string, v: unknown) {
        filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as number) <= (v as number));
        return api;
      },
      gt(c: string, v: unknown) {
        filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as number) > (v as number));
        return api;
      },
      gte(c: string, v: unknown) {
        filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as number) >= (v as number));
        return api;
      },
      order(col: string, o?: { ascending?: boolean }) {
        orderBy = { col, asc: o?.ascending !== false };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      range(a: number, b: number) {
        range = [a, b];
        return api;
      },
      single() {
        mode = "single";
        return Promise.resolve(execute());
      },
      maybeSingle() {
        mode = "maybe";
        return Promise.resolve(execute());
      },
      then<T1 = Result, T2 = never>(onOk?: (v: Result) => T1 | PromiseLike<T1>, onErr?: (e: unknown) => T2 | PromiseLike<T2>) {
        return Promise.resolve().then(execute).then(onOk, onErr);
      },
    };
    return api;
  }

  db.client = {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const h = opts.rpc?.[fn];
      if (!h) return { data: null, error: { code: "PGRST202", message: `no rpc ${fn}` } };
      try {
        return { data: await h(args, db), error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code ?? "P0001", message: String(e) } };
      }
    },
  };
  return db;
}
