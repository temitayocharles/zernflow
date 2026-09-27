import type { PGlite } from "@electric-sql/pglite";

/**
 * Generates Supabase-style TypeScript types from a migrated database (the
 * migrations are the schema source of truth). Used by
 * supabase/tests/db-types.test.ts, which fails when
 * lib/types/database.generated.ts is stale; refresh with `npm run db:types`.
 *
 * Mapping follows `supabase gen types typescript` conventions: bigint/numeric
 * → number, json/jsonb → Json, timestamps/uuid/text → string, arrays → T[],
 * enums → string unions; Insert fields are optional when nullable, defaulted,
 * identity or generated; view columns are nullable. Relationships are not
 * emitted (the hand-maintained lib/types/database.ts keeps those).
 */

interface ColumnInfo {
  tbl: string;
  kind: string;
  col: string;
  notnull: boolean;
  typname: string;
  typtype: string;
  typcategory: string;
  elem: string | null;
  elemtype: string | null;
  hasdef: boolean;
  identity: string;
  generated: string;
}

interface FunctionInfo {
  name: string;
  argnames: string[] | null;
  argtypes: string[];
  argmodes: string[] | null;
  nargdefaults: number;
  rettype: string;
  retset: boolean;
  rettyptype: string;
}

const SCALAR: Record<string, string> = {
  bool: "boolean",
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  oid: "number",
  json: "Json",
  jsonb: "Json",
  void: "undefined",
  record: "Json",
};

function mapType(typname: string, enums: Map<string, string[]>): string {
  if (SCALAR[typname]) return SCALAR[typname];
  const labels = enums.get(typname);
  if (labels) return labels.map((l) => JSON.stringify(l)).join(" | ");
  return "string";
}

function columnType(c: ColumnInfo, enums: Map<string, string[]>): string {
  if (c.typcategory === "A" && c.elem) {
    const inner = mapType(c.elem, enums);
    return inner.includes("|") ? `(${inner})[]` : `${inner}[]`;
  }
  return mapType(c.typname, enums);
}

const ident = (name: string) => (/^[a-z_][a-z0-9_]*$/i.test(name) ? name : JSON.stringify(name));

export async function generateDatabaseTypes(db: PGlite): Promise<string> {
  const enumRows = await db.query<{ typname: string; label: string }>(`
    select t.typname, e.enumlabel as label
      from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' order by t.typname, e.enumsortorder`);
  const enums = new Map<string, string[]>();
  for (const r of enumRows.rows) enums.set(r.typname, [...(enums.get(r.typname) ?? []), r.label]);

  const cols = await db.query<ColumnInfo>(`
    select c.relname as tbl, c.relkind::text as kind, a.attname as col, a.attnotnull as notnull,
           t.typname, t.typtype::text as typtype, t.typcategory::text as typcategory,
           et.typname as elem, et.typtype::text as elemtype,
           a.atthasdef as hasdef, a.attidentity::text as identity, a.attgenerated::text as generated
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
      left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
     where n.nspname = 'public' and c.relkind in ('r','p','v','m') and a.attnum > 0 and not a.attisdropped
     order by c.relname, a.attnum`);

  const byTable = new Map<string, ColumnInfo[]>();
  for (const c of cols.rows) byTable.set(c.tbl, [...(byTable.get(c.tbl) ?? []), c]);

  const fns = await db.query<FunctionInfo>(`
    select p.proname as name, p.proargnames as argnames,
           coalesce(
             (select array_agg(format('%s', t.typname) order by ord)
                from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as x(oid, ord)
                join pg_type t on t.oid = x.oid),
             '{}') as argtypes,
           p.proargmodes::text[] as argmodes, p.pronargdefaults as nargdefaults,
           rt.typname as rettype, p.proretset as retset, rt.typtype::text as rettyptype
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type rt on rt.oid = p.prorettype
     where n.nspname = 'public' and p.prokind = 'f' and rt.typname not in ('trigger', 'event_trigger')
     order by p.proname, p.oid`);

  const out: string[] = [];
  out.push(
    "// AUTO-GENERATED from supabase/migrations by lib/test/db-typegen.ts. Do not edit by hand.",
    "// Refresh: npm run db:types   (CI fails when this file is stale: supabase/tests/db-types.test.ts)",
    "",
    "export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];",
    "",
    "export type GeneratedDatabase = {",
    "  public: {",
    "    Tables: {",
  );

  const tables = [...byTable.entries()].filter(([, c]) => c[0].kind === "r" || c[0].kind === "p");
  const views = [...byTable.entries()].filter(([, c]) => c[0].kind === "v" || c[0].kind === "m");

  for (const [name, columns] of tables) {
    out.push(`      ${ident(name)}: {`);
    out.push("        Row: {");
    for (const c of columns) out.push(`          ${ident(c.col)}: ${columnType(c, enums)}${c.notnull ? "" : " | null"};`);
    out.push("        };", "        Insert: {");
    for (const c of columns) {
      if (c.generated === "s") continue;
      const optional = !c.notnull || c.hasdef || c.identity !== "";
      out.push(`          ${ident(c.col)}${optional ? "?" : ""}: ${columnType(c, enums)}${c.notnull ? "" : " | null"};`);
    }
    out.push("        };", "        Update: {");
    for (const c of columns) {
      if (c.generated === "s") continue;
      out.push(`          ${ident(c.col)}?: ${columnType(c, enums)}${c.notnull ? "" : " | null"};`);
    }
    out.push("        };", "      };");
  }
  out.push("    };", "    Views: {");
  for (const [name, columns] of views) {
    out.push(`      ${ident(name)}: {`, "        Row: {");
    for (const c of columns) out.push(`          ${ident(c.col)}: ${columnType(c, enums)} | null;`);
    out.push("        };", "      };");
  }
  out.push("    };", "    Functions: {");

  const seen = new Set<string>();
  for (const f of fns.rows) {
    if (seen.has(f.name)) continue; // overloads: first definition wins (none today)
    seen.add(f.name);
    const modes = f.argmodes ?? f.argtypes.map(() => "i");
    const names = f.argnames ?? [];
    const inArgs: string[] = [];
    const tableCols: string[] = [];
    const inCount = modes.filter((m) => m === "i" || m === "b" || m === "v").length;
    let inIndex = 0;
    modes.forEach((mode, i) => {
      const type = mapType(f.argtypes[i]?.replace(/^_/, "") ?? "text", enums) + (f.argtypes[i]?.startsWith("_") ? "[]" : "");
      const argName = names[i] || `arg${i}`;
      if (mode === "i" || mode === "b" || mode === "v") {
        const optional = inIndex >= inCount - f.nargdefaults;
        inArgs.push(`${ident(argName)}${optional ? "?" : ""}: ${type}`);
        inIndex += 1;
      } else if (mode === "t" || mode === "o") {
        tableCols.push(`${ident(argName)}: ${type}`);
      }
    });
    let returns: string;
    if (tableCols.length > 0) returns = `{ ${tableCols.join("; ")} }${f.retset ? "[]" : ""}`;
    else {
      const base = f.rettyptype === "c" ? "Json" : mapType(f.rettype.replace(/^_/, ""), enums) + (f.rettype.startsWith("_") ? "[]" : "");
      returns = f.retset ? `${base.includes("|") ? `(${base})` : base}[]` : base;
    }
    const args = inArgs.length ? `{ ${inArgs.join("; ")} }` : "Record<PropertyKey, never>";
    out.push(`      ${ident(f.name)}: { Args: ${args}; Returns: ${returns} };`);
  }
  out.push("    };", "    Enums: {");
  for (const [name, labels] of enums) out.push(`      ${ident(name)}: ${labels.map((l) => JSON.stringify(l)).join(" | ")};`);
  out.push("    };", "  };", "};", "");
  out.push(
    'export type GeneratedTables = GeneratedDatabase["public"]["Tables"];',
    'export type GeneratedRow<T extends keyof GeneratedTables> = GeneratedTables[T]["Row"];',
    "",
  );
  return out.join("\n");
}
