import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function getRuntimeSupabaseConfig() {
  const runtimeEnv = process.env as Record<string, string | undefined>;
  const supabaseUrl =
    runtimeEnv["SUPABASE_URL"] ?? runtimeEnv["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseAnonKey =
    runtimeEnv["SUPABASE_ANON_KEY"] ??
    runtimeEnv["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("ZernFlow Supabase runtime configuration is unavailable.");
  }

  return { supabaseUrl, supabaseAnonKey };
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const { supabaseUrl, supabaseAnonKey } = getRuntimeSupabaseConfig();

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAuthCallback = pathname === "/auth/callback";
  const isDashboard = pathname.startsWith("/dashboard");
  const isApiRoute = pathname.startsWith("/api/");

  // Auth callback and API routes (including webhooks) always pass through.
  if (isAuthCallback || isApiRoute) {
    return supabaseResponse;
  }

  // Keep /login and /register reachable even when a session cookie exists.
  // Successful auth flows navigate to /dashboard themselves. This makes the
  // auth pages a safe recovery path and prevents a user-without-workspace
  // state from bouncing /dashboard -> /login -> /dashboard indefinitely.

  // Redirect unauthenticated dashboard requests to login.
  if (!user && isDashboard) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const redirectResponse = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie.name, cookie.value);
    });
    return redirectResponse;
  }

  return supabaseResponse;
}
