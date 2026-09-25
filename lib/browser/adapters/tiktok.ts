import type { BrowserAdapter } from "../contract";

export const tiktokAdapter: BrowserAdapter = {
  platform: "tiktok",
  label: "TikTok",
  allowedHosts: ["tiktok.com"],
  storageDomains: ["tiktok.com"],
  capabilities: [
    { operation: "session_check", level: "experimental", note: "Read-only sign-in check; contract-tested on fixtures, no live acceptance recorded yet." },
    { operation: "publish_post", level: "unsupported", note: "Use the Content Posting API through the Gateway, or publish manually." },
  ],
  signals: {
    checkUrl: "https://www.tiktok.com/setting",
    cookieDomain: "tiktok.com",
    authCookies: ["sessionid"],
    loginPaths: ["/login"],
    challengePaths: ["/verify", "captcha"],
    mfaPaths: ["/login/2sv"],
    signedInMarkers: ['[data-e2e="profile-icon"]', '[data-e2e="nav-profile"]'],
  },
};
