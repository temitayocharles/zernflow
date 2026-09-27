/**
 * Compile-time drift guard (type-only; emits no runtime code).
 *
 * lib/types/database.ts is the hand-maintained application contract: it
 * narrows CHECK-constrained text columns to unions and carries
 * relationships. lib/types/database.generated.ts is generated from the
 * migrations. These assertions fail `tsc` when the hand contract references
 * a table or column that the migrations do not create, so the two cannot
 * silently diverge. (Omitting a column from the hand contract is allowed:
 * e.g. legacy secret columns are deliberately not exposed.)
 */
import type { Database } from "./database";
import type { GeneratedDatabase, Json } from "./database.generated";

type Hand = Database["public"]["Tables"];
type Gen = GeneratedDatabase["public"]["Tables"];

/** Tables typed by hand that no migration creates. */
export type UnknownTables = Exclude<keyof Hand, keyof Gen>;

/** `table.column` pairs typed by hand that no migration creates. */
export type UnknownColumns = {
  [T in keyof Hand & keyof Gen]: Exclude<keyof Hand[T]["Row"], keyof Gen[T]["Row"]> extends infer C
    ? C extends string
      ? `${T & string}.${C}`
      : never
    : never;
}[keyof Hand & keyof Gen];

/**
 * `table.column` pairs the hand contract types as non-null although the
 * database allows NULL (a latent runtime null bug). Json columns are skipped:
 * the Json type itself includes null.
 */
type RawNullabilityMismatches = {
  [T in keyof Hand & keyof Gen]: {
    [C in keyof Hand[T]["Row"] & keyof Gen[T]["Row"]]: Json extends Gen[T]["Row"][C]
      ? never
      : null extends Gen[T]["Row"][C]
        ? null extends Hand[T]["Row"][C]
          ? never
          : `${T & string}.${C & string}`
        : never;
  }[keyof Hand[T]["Row"] & keyof Gen[T]["Row"]];
}[keyof Hand & keyof Gen];

/**
 * Reviewed pre-existing mismatches (historical migrations declared these with
 * a DEFAULT but without NOT NULL; no writer sets NULL). Tightening them needs a
 * live-data forward migration (backfill + SET NOT NULL), tracked in the ledger.
 * Do not add to this list to silence a new mismatch: fix the type instead.
 */
export type KnownNullabilityExceptions =
  | "sequence_enrollments.enrolled_at"
  | "sequences.created_at"
  | "sequences.updated_at"
  | "workspace_invites.created_at"
  | "workspace_invites.expires_at";

export type NullabilityMismatches = Exclude<RawNullabilityMismatches, KnownNullabilityExceptions>;

/** Hand-typed functions that no migration defines. */
export type UnknownFunctions = Exclude<
  keyof Database["public"]["Functions"],
  keyof GeneratedDatabase["public"]["Functions"]
>;

type AssertNever<T extends never> = T;
export type DriftChecks = [
  AssertNever<UnknownTables>,
  AssertNever<UnknownColumns>,
  AssertNever<NullabilityMismatches>,
  // An exception that no longer mismatches must be removed from the list.
  AssertNever<Exclude<KnownNullabilityExceptions, RawNullabilityMismatches>>,
  AssertNever<UnknownFunctions>,
];
