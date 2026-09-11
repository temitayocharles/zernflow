/** Validate every destructive smoke input before constructing clients or making requests. */
export function smokeConfig(env, argumentUrl) {
  if (env.SMOKE_ALLOW_WRITES !== "disposable-environment-only") {
    throw new Error("Set SMOKE_ALLOW_WRITES=disposable-environment-only only for an isolated test environment");
  }
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const parseUrl = (value, name) => {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query or fragment`);
    }
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error(`${name} must use HTTPS outside loopback`);
    }
    return url.origin;
  };
  const uuid = (name) => {
    const value = required(name);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID`);
    return value;
  };
  return {
    baseUrl: parseUrl(argumentUrl || required("SMOKE_BASE_URL"), "SMOKE_BASE_URL"),
    workspaceId: uuid("SMOKE_WORKSPACE_ID"),
    channelId: uuid("SMOKE_CHANNEL_ID"),
    accountId: required("SMOKE_ACCOUNT_ID"),
    supabaseUrl: parseUrl(required("NEXT_PUBLIC_SUPABASE_URL"), "NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
