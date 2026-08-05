import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/types/database";
import { getSupabaseCookieOptions } from "@/lib/supabase/cookie-options";

const APPLICATION_SCHEMA = "omni_channel" as "public";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: APPLICATION_SCHEMA },
      cookieOptions: getSupabaseCookieOptions(),
    }
  );
}
