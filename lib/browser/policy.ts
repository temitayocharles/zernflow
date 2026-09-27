import type { BrowserAdapter, BrowserSurface, DetectedSessionState, SessionCheckResult } from "./contract";

/**
 * Challenge detection shared by every adapter. Anything that looks like a
 * CAPTCHA, checkpoint or second-factor prompt stops the task and hands it to a
 * human; nothing in the product attempts to solve or bypass it.
 */
export const GENERIC_CHALLENGE_FRAMES = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="captcha"]',
  'iframe[src*="arkoselabs"]',
  'iframe[src*="funcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
] as const;
export const GENERIC_MFA_INPUTS = ['input[autocomplete="one-time-code"]'] as const;
export const GENERIC_PASSWORD_INPUTS = ['input[type="password"]'] as const;

/** Task outcome for each detected state (EXECUTION_MODEL.md error taxonomy). */
export const STATE_OUTCOME: Record<DetectedSessionState, { ok: boolean; errorClass?: "reauth_required" | "human_challenge" | "auth_expired"; human: boolean }> = {
  healthy: { ok: true, human: false },
  degraded: { ok: true, human: false },
  human_login_required: { ok: false, errorClass: "reauth_required", human: true },
  expired: { ok: false, errorClass: "auth_expired", human: true },
  mfa_required: { ok: false, errorClass: "human_challenge", human: true },
  challenge_required: { ok: false, errorClass: "human_challenge", human: true },
};

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return "";
  }
}

async function anyPresent(surface: BrowserSurface, selectors: readonly string[]): Promise<boolean> {
  for (const s of selectors) if ((await surface.count(s)) > 0) return true;
  return false;
}

/**
 * Read-only session check: navigate to the adapter's signed-in page and
 * classify. Order matters: challenge → MFA → signed out → signed in.
 */
export async function checkSession(adapter: BrowserAdapter, surface: BrowserSurface): Promise<SessionCheckResult> {
  const s = adapter.signals;
  await surface.navigate(s.checkUrl);
  const finalUrl = surface.currentUrl();
  const path = pathOf(finalUrl);
  const done = async (state: DetectedSessionState, reason: string): Promise<SessionCheckResult> => {
    if (state !== "healthy") await surface.screenshot(`session-${state}`);
    return { state, reason, finalUrl };
  };

  if (s.challengePaths.some((p) => path.includes(p)) || (await anyPresent(surface, GENERIC_CHALLENGE_FRAMES))) {
    return done("challenge_required", "The platform is showing a verification checkpoint. Complete it yourself, then re-import the session.");
  }
  if (s.mfaPaths.some((p) => path.includes(p)) || (await anyPresent(surface, GENERIC_MFA_INPUTS))) {
    return done("mfa_required", "The platform is asking for a second factor. Sign in yourself and re-import the session.");
  }
  const cookies = await surface.cookieNames(s.cookieDomain);
  const hasAuthCookie = s.authCookies.every((c) => cookies.includes(c));
  const onLogin = s.loginPaths.some((p) => path.includes(p)) || (await anyPresent(surface, GENERIC_PASSWORD_INPUTS));
  if (onLogin || !hasAuthCookie) {
    return done(hasAuthCookie ? "expired" : "human_login_required", onLogin ? "The platform redirected to its sign-in page." : "The signed-in session cookie is missing.");
  }
  if (await anyPresent(surface, s.signedInMarkers)) return done("healthy", "Signed in.");
  return done("degraded", "Session cookie present but the signed-in page was not recognised (layout change or partial load).");
}
