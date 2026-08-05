import type { CookieOptionsWithName } from "@supabase/ssr";

export function getSupabaseCookieOptions(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): CookieOptionsWithName {
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: nodeEnv === "production",
  };
}
