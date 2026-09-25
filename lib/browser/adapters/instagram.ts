import type { BrowserAdapter } from "../contract";

/** Selectors and paths live only here; business logic never references them. */
export const instagramAdapter: BrowserAdapter = {
  platform: "instagram",
  label: "Instagram",
  allowedHosts: ["instagram.com"],
  storageDomains: ["instagram.com"],
  capabilities: [
    { operation: "session_check", level: "experimental", note: "Read-only sign-in check; contract-tested on fixtures, no live acceptance recorded yet." },
    { operation: "publish_post", level: "unsupported", note: "Use the official API through the Gateway, or publish manually." },
  ],
  signals: {
    checkUrl: "https://www.instagram.com/accounts/edit/",
    cookieDomain: "instagram.com",
    authCookies: ["sessionid"],
    loginPaths: ["/accounts/login"],
    challengePaths: ["/challenge/", "/accounts/suspended"],
    mfaPaths: ["/accounts/login/two_factor"],
    signedInMarkers: ['a[href="/direct/inbox/"]', 'a[href="/accounts/edit/"]', 'svg[aria-label="Home"]'],
  },
};
