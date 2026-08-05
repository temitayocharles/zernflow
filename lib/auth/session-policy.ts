export const SESSION_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function isSessionMaxAgeExceeded(
  lastSignInAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastSignInAt) return true;
  const signedInAt = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedInAt)) return true;
  return now - signedInAt >= SESSION_MAX_AGE_MS;
}

export function isSessionInactive(
  lastActivityAt: number | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastActivityAt || !Number.isFinite(lastActivityAt)) return false;
  return now - lastActivityAt >= SESSION_INACTIVITY_TIMEOUT_MS;
}
