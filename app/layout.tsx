import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });
const appUrl = (
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export const metadata: Metadata = {
  title: {
    default: "ZernFlow - The Open Source ManyChat Alternative",
    template: "%s | ZernFlow",
  },
  description:
    "Automate DMs, comments, and flows across Instagram, Facebook, Telegram, X, Bluesky, and Reddit. Free, self-hostable, and open source.",
  metadataBase: new URL(appUrl),
  openGraph: {
    title: "ZernFlow - The Open Source ManyChat Alternative",
    description:
      "Automate DMs, comments, and flows across Instagram, Facebook, Telegram, X, Bluesky, and Reddit. Free, self-hostable, and open source.",
    url: appUrl,
    siteName: "ZernFlow",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ZernFlow - The Open Source ManyChat Alternative",
    description:
      "Automate DMs, comments, and flows across 6 platforms. Free, self-hostable, open source.",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure public browser configuration is read from the deployment's runtime
  // environment rather than frozen into the image during `next build`.
  await connection();

  const runtimeEnv = process.env as Record<string, string | undefined>;
  const runtimeConfig = JSON.stringify({
    supabaseUrl: runtimeEnv["NEXT_PUBLIC_SUPABASE_URL"] ?? "",
    supabaseAnonKey: runtimeEnv["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? "",
    githubAuthEnabled:
      runtimeEnv["NEXT_PUBLIC_GITHUB_AUTH_ENABLED"] === "true",
  }).replace(/</g, "\\u003c");

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          id="zernflow-runtime-config"
          dangerouslySetInnerHTML={{
            __html: `window.__ZERNFLOW_RUNTIME_CONFIG__=${runtimeConfig};`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("theme")==="dark"||(!localStorage.getItem("theme")&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`,
          }}
        />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
