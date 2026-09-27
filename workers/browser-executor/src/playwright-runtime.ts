import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright-core";
import type { BrowserSurface } from "../../../lib/browser/contract";
import { checkSession } from "../../../lib/browser/policy";
import { isAllowedNavigation, isBlockedRequest } from "../../../lib/browser/network";
import type { BrowserRuntime, CheckOutput } from "./loop";

export interface RuntimeOptions {
  navigationTimeoutMs: number;
  checkTimeoutMs: number;
}

/**
 * One fresh Chromium process and context per task: no persistent profile, no
 * downloads, service workers blocked, requests to private/metadata networks
 * aborted, and top-level navigation confined to the adapter's hosts. Nothing
 * here types credentials or interacts with challenges.
 */
export function createPlaywrightRuntime(opts: RuntimeOptions): BrowserRuntime {
  return {
    async runSessionCheck({ adapter, storageState, allowedHosts }): Promise<CheckOutput> {
      const workDir = await mkdtemp(join(tmpdir(), "zf-browser-"));
      let browser: Browser | null = null;
      let timer: NodeJS.Timeout | undefined;
      try {
        browser = await chromium.launch({ headless: true, downloadsPath: workDir, args: ["--disable-dev-shm-usage"] });
        const context: BrowserContext = await browser.newContext({
          storageState: storageState as BrowserContextOptions["storageState"],
          acceptDownloads: false,
          serviceWorkers: "block",
          viewport: { width: 1280, height: 800 },
          javaScriptEnabled: true,
        });
        context.setDefaultNavigationTimeout(opts.navigationTimeoutMs);
        context.setDefaultTimeout(Math.min(opts.navigationTimeoutMs, 15_000));
        await context.route("**/*", (route) => {
          const request = route.request();
          const url = request.url();
          if (isBlockedRequest(url)) return route.abort("blockedbyclient");
          if (request.isNavigationRequest() && request.frame().parentFrame() === null && !isAllowedNavigation(url, allowedHosts)) {
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
        const page: Page = await context.newPage();
        page.on("popup", (p) => void p.close().catch(() => undefined));
        page.on("dialog", (d) => void d.dismiss().catch(() => undefined));

        const screenshots: CheckOutput["screenshots"] = [];
        const surface: BrowserSurface = {
          async navigate(url) {
            if (!isAllowedNavigation(url, allowedHosts)) throw new Error("Navigation outside the adapter allowlist was refused");
            const res = await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e: Error) => {
              if (/ERR_BLOCKED_BY_CLIENT/.test(e.message)) return null;
              throw e;
            });
            await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
            return { status: res?.status() ?? null };
          },
          currentUrl: () => page.url(),
          count: (css) => page.locator(css).count(),
          async cookieNames(domainSuffix) {
            const suffix = domainSuffix.replace(/^\./, "");
            return (await context.cookies())
              .filter((c) => {
                const d = c.domain.replace(/^\./, "");
                return d === suffix || d.endsWith(`.${suffix}`);
              })
              .map((c) => c.name);
          },
          async screenshot(label) {
            if (screenshots.length >= 3) return;
            screenshots.push({ label: label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60), bytes: await page.screenshot({ type: "png", fullPage: false }) });
          },
        };

        const run = (async () => {
          const result = await checkSession(adapter, surface);
          const refreshed = result.state === "healthy" ? JSON.stringify(await context.storageState()) : null;
          return { result, screenshots, storageState: refreshed };
        })();
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Session check exceeded ${opts.checkTimeoutMs} ms`)), opts.checkTimeoutMs);
        });
        return await Promise.race([run, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        await browser?.close().catch(() => undefined);
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
