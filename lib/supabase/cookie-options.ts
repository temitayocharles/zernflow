import type { CookieOptionsWithName } from "@supabase/ssr";

export function getSupabaseCookieOptions(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): CookieOptionsWithName {
  // Supabase browser clients must read the session cookie to refresh tokens and
  // power Realtime. Keep it JavaScript-readable, but enforce transport and CSRF
  // protections explicitly in production.
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: nodeEnv === "production",
  };
}
