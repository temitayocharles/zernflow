import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/types/database";

type ZernFlowRuntimeConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  githubAuthEnabled: boolean;
};

declare global {
  interface Window {
    __ZERNFLOW_RUNTIME_CONFIG__?: ZernFlowRuntimeConfig;
  }
}

function getSupabaseConfig() {
  if (typeof window !== "undefined") {
    const config = window.__ZERNFLOW_RUNTIME_CONFIG__;
    if (config?.supabaseUrl && config?.supabaseAnonKey) {
      return config;
    }
  }

  // Dynamic lookup avoids freezing NEXT_PUBLIC_* values into the client bundle.
  // This branch is used during server rendering; the browser reads the config
  // injected by the root layout from the runtime environment.
  const runtimeEnv = process.env as Record<string, string | undefined>;
  return {
    supabaseUrl: runtimeEnv["NEXT_PUBLIC_SUPABASE_URL"] ?? "",
    supabaseAnonKey: runtimeEnv["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? "",
    githubAuthEnabled:
      runtimeEnv["NEXT_PUBLIC_GITHUB_AUTH_ENABLED"] === "true",
  };
}

export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("ZernFlow Supabase runtime configuration is unavailable.");
  }

  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
}

export function isGitHubAuthEnabled() {
  return getSupabaseConfig().githubAuthEnabled;
}
