import {
  choice,
  InputError,
  integer,
  object,
  text,
  timestamp,
  uuid,
} from "@/lib/product/validation";
export const resources = ["companies", "deals", "customer_profiles"] as const;
export type CrmResource = (typeof resources)[number];
export function isCrmResource(value: string): value is CrmResource {
  return resources.includes(value as CrmResource);
}
export const lifecycleStages = ["lead", "qualified", "customer", "inactive"];
export const dealStages = [
  "new",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
];
export function parseCrmInput(
  resource: CrmResource,
  value: unknown,
  update = false,
) {
  const input = object(value);
  const result: Record<string, string | number | null> = {};
  const fields =
    resource === "companies"
      ? ["name", "domain", "description", "owner_id", "lifecycle", "source"]
      : resource === "deals"
        ? [
            "name",
            "description",
            "company_id",
            "contact_id",
            "owner_id",
            "stage",
            "value_minor",
            "currency",
            "expected_close_at",
          ]
        : [
            "contact_id",
            "company_id",
            "owner_id",
            "lifecycle",
            "source",
            "lead_score",
          ];
  for (const [key, v] of Object.entries(input)) {
    if (key === "version" && update) {
      result.version = integer(v, key, 1);
      continue;
    }
    if (
      !fields.includes(key) ||
      (update && resource === "customer_profiles" && key === "contact_id")
    )
      throw new InputError(`Unknown or immutable field: ${key}`);
    if (key.endsWith("_id")) result[key] = v === null ? null : uuid(v, key);
    else if (key === "lifecycle") result[key] = choice(v, key, lifecycleStages);
    else if (key === "stage") result[key] = choice(v, key, dealStages);
    else if (key === "value_minor" || key === "lead_score")
      result[key] = integer(
        v,
        key,
        0,
        key === "lead_score" ? 100 : Number.MAX_SAFE_INTEGER,
      );
    else if (key === "expected_close_at")
      result[key] = v === null ? null : timestamp(v, key);
    else if (key === "currency") {
      const currency = text(v, key, 3, true);
      if (!/^[A-Z]{3}$/.test(currency))
        throw new InputError("Use an uppercase ISO currency code");
      result[key] = currency;
    } else
      result[key] = text(
        v,
        key,
        key === "description" ? 10000 : key === "domain" ? 253 : 200,
        key === "name",
      );
  }
  if (update && !result.version)
    throw new InputError("version is required to prevent lost updates");
  if (
    !update &&
    !(resource === "customer_profiles" ? result.contact_id : result.name)
  )
    throw new InputError(
      resource === "customer_profiles"
        ? "contact_id required"
        : "name required",
    );
  return result;
}
