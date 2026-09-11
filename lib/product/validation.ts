export class InputError extends Error {}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("A JSON object is required");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max=200, required=false): string {
  if (typeof value !== "string" || value.length>max || (required && !value.trim())) throw new InputError(`Invalid ${name}`);
  return value.trim();
}
export function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw new InputError(`Invalid ${name}`);
  return value;
}
export function integer(value: unknown, name: string, min=0, max=Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value<min || value>max) throw new InputError(`Invalid ${name}`);
  return value;
}
export function choice(value: unknown, name: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new InputError(`Invalid ${name}`);
  return value;
}
export function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InputError(`Invalid ${name}`);
  return new Date(value).toISOString();
}
