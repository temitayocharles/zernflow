import type { BrowserAdapter } from "../contract";

export const linkedinAdapter: BrowserAdapter = {
  platform: "linkedin",
  label: "LinkedIn",
  allowedHosts: ["linkedin.com"],
  storageDomains: ["linkedin.com"],
  capabilities: [
    { operation: "session_check", level: "experimental", note: "Read-only sign-in check; contract-tested on fixtures, no live acceptance recorded yet." },
    { operation: "publish_post", level: "unsupported", note: "Use the official API through the Gateway, or publish manually." },
  ],
  signals: {
    checkUrl: "https://www.linkedin.com/feed/",
    cookieDomain: "linkedin.com",
    authCookies: ["li_at"],
    loginPaths: ["/login", "/uas/login", "/authwall"],
    challengePaths: ["/checkpoint/"],
    mfaPaths: ["/two-step-verification"],
    signedInMarkers: ["#global-nav", 'a[href*="/mynetwork/"]'],
  },
};
