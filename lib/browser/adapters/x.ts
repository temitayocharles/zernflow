import type { BrowserAdapter } from "../contract";

/** Platform id "twitter" matches the channel platform used elsewhere. */
export const xAdapter: BrowserAdapter = {
  platform: "twitter",
  label: "X",
  allowedHosts: ["x.com", "twitter.com"],
  storageDomains: ["x.com", "twitter.com"],
  capabilities: [
    { operation: "session_check", level: "experimental", note: "Read-only sign-in check; contract-tested on fixtures, no live acceptance recorded yet." },
    { operation: "publish_post", level: "unsupported", note: "Use the official API, or publish manually." },
  ],
  signals: {
    checkUrl: "https://x.com/settings/account",
    cookieDomain: "x.com",
    authCookies: ["auth_token"],
    loginPaths: ["/i/flow/login", "/login"],
    challengePaths: ["/account/access", "/account/locked"],
    mfaPaths: ["/i/flow/two-factor", "/account/login_verification"],
    signedInMarkers: ['a[data-testid="AppTabBar_Home_Link"]', '[data-testid="SideNav_AccountSwitcher_Button"]'],
  },
};
