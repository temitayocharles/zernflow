import {
  InputError,
  object,
  uuid,
  integer,
  choice,
} from "@/lib/product/validation";
import { workStatuses, workPriorities } from "./work-items";
export function parseBulkWorkChanges(value: unknown) {
  const input = object(value);
  if (
    !Array.isArray(input.changes) ||
    input.changes.length < 1 ||
    input.changes.length > 50
  )
    throw new InputError("Select one to fifty work items");
  const ids = new Set<string>();
  return input.changes.map((value) => {
    const row = object(value);
    for (const key of Object.keys(row))
      if (!["id", "version", "status", "priority"].includes(key))
        throw new InputError("Unsupported bulk field");
    const id = uuid(row.id, "id");
    if (ids.has(id)) throw new InputError("Duplicate work item");
    ids.add(id);
    const version = integer(row.version, "version", 1);
    if (row.status === undefined && row.priority === undefined)
      throw new InputError("Choose status or priority");
    return {
      id,
      version,
      ...(row.status !== undefined
        ? { status: choice(row.status, "status", workStatuses) }
        : {}),
      ...(row.priority !== undefined
        ? { priority: choice(row.priority, "priority", workPriorities) }
        : {}),
    };
  });
}
