import type { NextConfig } from "next";
import {
  AUTH_NO_STORE_HEADER,
  getSecurityHeaders,
} from "./lib/security-headers";

const securityHeaders = getSecurityHeaders();
const authNoStoreRoutes = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/auth/:path*",
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      ...authNoStoreRoutes.map((source) => ({
        source,
        headers: [AUTH_NO_STORE_HEADER],
      })),
    ];
  },
};

export default nextConfig;
