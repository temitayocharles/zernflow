import type { BrowserSurface } from "./contract";

/** Test double (run under `@vitest-environment jsdom`): serves HTML fixtures per URL and records every call. */
export class FakeSurface implements BrowserSurface {
  calls: string[] = [];
  screenshots: string[] = [];
  private url = "about:blank";
  private doc: Document | null = null;
  constructor(
    private readonly routes: Record<string, { finalUrl?: string; html: string; status?: number }>,
    private readonly cookies: { name: string; domain: string }[] = [],
  ) {}
  async navigate(url: string) {
    this.calls.push(`navigate:${url}`);
    const r = this.routes[url];
    if (!r) throw new Error(`no fixture for ${url}`);
    this.url = r.finalUrl ?? url;
    this.doc = new DOMParser().parseFromString(r.html, "text/html");
    return { status: r.status ?? 200 };
  }
  currentUrl() {
    return this.url;
  }
  async count(css: string) {
    this.calls.push(`count:${css}`);
    return this.doc ? this.doc.querySelectorAll(css).length : 0;
  }
  async cookieNames(domainSuffix: string) {
    this.calls.push(`cookies:${domainSuffix}`);
    return this.cookies.filter((c) => c.domain.replace(/^\./, "").endsWith(domainSuffix)).map((c) => c.name);
  }
  async screenshot(label: string) {
    this.screenshots.push(label);
  }
}

/** Wraps a surface so any member outside the read-only contract throws. */
export function strictSurface(surface: FakeSurface): BrowserSurface {
  const allowed = new Set(["navigate", "currentUrl", "count", "cookieNames", "screenshot"]);
  return new Proxy(surface, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !allowed.has(prop) && prop !== "then") throw new Error(`adapter touched forbidden surface member: ${prop}`);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as BrowserSurface;
}
