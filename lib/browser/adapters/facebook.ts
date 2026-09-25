import type { BrowserAdapter } from "../contract";

export const facebookAdapter: BrowserAdapter = {
  platform: "facebook",
  label: "Facebook",
  allowedHosts: ["facebook.com"],
  storageDomains: ["facebook.com"],
  capabilities: [
    { operation: "session_check", level: "experimental", note: "Read-only sign-in check; contract-tested on fixtures, no live acceptance recorded yet." },
    { operation: "publish_post", level: "unsupported", note: "Use the official Pages API through the Gateway, or publish manually." },
  ],
  signals: {
    checkUrl: "https://www.facebook.com/settings",
    cookieDomain: "facebook.com",
    authCookies: ["c_user", "xs"],
    loginPaths: ["/login"],
    challengePaths: ["/checkpoint/"],
    mfaPaths: ["/two_step_verification/", "/login/approvals"],
    signedInMarkers: ['div[role="banner"]', 'div[role="navigation"]'],
  },
};
