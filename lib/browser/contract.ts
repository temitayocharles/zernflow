/**
 * Managed browser adapter contract (docs/architecture/BROWSER_AUTOMATION_DESIGN.md).
 *
 * Self-contained: relative imports only, no Next.js / Supabase dependencies, so
 * the web control plane and the standalone executor share one definition.
 *
 * Adapters see a BrowserSurface, never a raw Playwright page. The surface is
 * deliberately read-only (navigate, inspect, screenshot): no click, type or
 * script evaluation, so an adapter cannot solve a challenge, fill an MFA code
 * or drive a login even by accident. Write capabilities (publishing) will add
 * narrowly-scoped surface methods only when a capability reaches `verified`.
 */

export type VerificationLevel = "verified" | "experimental" | "unsupported";
export type BrowserOperation = "session_check" | "publish_post";

export type DetectedSessionState =
  | "healthy"
  | "degraded"
  | "human_login_required"
  | "expired"
  | "mfa_required"
  | "challenge_required";

export interface BrowserSurface {
  /** Top-level navigation; the runtime refuses hosts outside the adapter's allowlist. */
  navigate(url: string): Promise<{ status: number | null }>;
  currentUrl(): string;
  /** Number of elements matching a CSS selector in the main frame. */
  count(css: string): Promise<number>;
  /** Cookie names currently set for hosts ending in `domainSuffix`. */
  cookieNames(domainSuffix: string): Promise<string[]>;
  /** Captures a screenshot artifact (uploaded by the runtime). */
  screenshot(label: string): Promise<void>;
}

export interface SessionSignals {
  /** Page proving an authenticated session (visited during a check). */
  checkUrl: string;
  /** Cookie domain suffix and the cookie(s) that only exist while signed in. */
  cookieDomain: string;
  authCookies: readonly string[];
  /** Path fragments meaning "signed out, log in again". */
  loginPaths: readonly string[];
  /** Path fragments meaning a verification checkpoint (never automated). */
  challengePaths: readonly string[];
  /** Path fragments meaning a second factor is being requested. */
  mfaPaths: readonly string[];
  /** CSS present only in the signed-in app shell (confirms, never required alone). */
  signedInMarkers: readonly string[];
}

export interface BrowserCapability {
  operation: BrowserOperation;
  level: VerificationLevel;
  note: string;
}

export interface BrowserAdapter {
  platform: string;
  label: string;
  /** Hosts the runtime may navigate to at top level (exact or subdomain match). */
  allowedHosts: readonly string[];
  /** Cookie/localStorage domains accepted when importing a storage state. */
  storageDomains: readonly string[];
  capabilities: readonly BrowserCapability[];
  signals: SessionSignals;
}

export interface SessionCheckResult {
  state: DetectedSessionState;
  reason: string;
  finalUrl: string;
}

export function capabilityOf(adapter: BrowserAdapter, operation: BrowserOperation): BrowserCapability {
  return (
    adapter.capabilities.find((c) => c.operation === operation) ?? {
      operation,
      level: "unsupported",
      note: "Not implemented for this platform.",
    }
  );
}
