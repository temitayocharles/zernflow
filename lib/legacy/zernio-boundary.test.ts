import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Zernio stage-2 guard (removal manifest §3). The legacy Zernio surface is a
 * closed set: nothing outside this allowlist may import the Zernio SDK or the
 * lib/zernio-* modules, so the final deletion is exactly these files plus the
 * dependency. Adding a new importer fails CI instead of silently widening the
 * removal (and reintroducing hosted Zernio as a dependency).
 */
const ROOT = join(__dirname, "..", "..");
const SCAN = ["app", "lib", "components", "scripts", "workers", "middleware.ts", "proxy.ts"];
const SKIP = new Set(["node_modules", ".next", "dist", "build", "coverage"]);
const ALLOWED = new Set([
  "app/api/webhooks/late/route.ts",
  "lib/social-gateway/comment-reply.ts",
  "lib/zernio-client.ts",
  "lib/zernio-client.test.ts",
  "lib/zernio-webhook.ts",
  "lib/zernio-webhook.test.ts",
]);
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](@zernio\/node|[^"']*zernio-(?:client|webhook))["']/;

function walk(path: string, out: string[]) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (!SKIP.has(name)) walk(join(path, name), out);
  } else if (/\.(ts|tsx|mjs|js)$/.test(path)) out.push(path);
}

describe("legacy Zernio import boundary", () => {
  it("only allowlisted files import the Zernio SDK or lib/zernio-* modules", () => {
    const files: string[] = [];
    for (const entry of SCAN) walk(join(ROOT, entry), files);
    const importers = files
      .filter((f) => IMPORT.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f).split("\\").join("/"))
      .sort();
    expect(importers.filter((f) => !ALLOWED.has(f))).toEqual([]);
    expect(importers.length).toBeGreaterThan(0);
  });

  it("keeps the Zernio SDK out of the browser executor worker", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "workers/browser-executor/package.json"), "utf8"));
    expect(JSON.stringify(pkg)).not.toMatch(/zernio/i);
  });
});
