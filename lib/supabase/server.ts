import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/types/database";

function getRuntimeSupabaseConfig() {
  const runtimeEnv = process.env as Record<string, string | undefined>;
  const supabaseUrl =
    runtimeEnv["SUPABASE_URL"] ?? runtimeEnv["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseAnonKey =
    runtimeEnv["SUPABASE_ANON_KEY"] ??
    runtimeEnv["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  const serviceRoleKey = runtimeEnv["SUPABASE_SERVICE_ROLE_KEY"];

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("ZernFlow Supabase runtime configuration is unavailable.");
  }

  return { supabaseUrl, supabaseAnonKey, serviceRoleKey };
}

export async function createClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getRuntimeSupabaseConfig();

  return createServerClient<Database>(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component. Can be ignored if middleware refreshes sessions.
          }
        },
      },
    }
  );
}

export async function createServiceClient() {
  const { supabaseUrl, serviceRoleKey } = getRuntimeSupabaseConfig();

  if (!serviceRoleKey) {
    throw new Error("ZernFlow Supabase service role configuration is unavailable.");
  }

  return createServerClient<Database>(
    supabaseUrl,
    serviceRoleKey,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    }
  );
}
