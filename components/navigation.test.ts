import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { activeHref, NAVIGATION } from "./navigation";

describe("navigation", () => {
  it("selects the most specific entry", () => {
    expect(activeHref("/dashboard")).toBe("/dashboard");
    expect(activeHref("/dashboard/settings/team")).toBe("/dashboard/settings/team");
    expect(activeHref("/dashboard/settings")).toBe("/dashboard/settings");
    expect(activeHref("/dashboard/content/abc")).toBe("/dashboard/content");
    expect(activeHref("/dashboard/contentious")).toBeNull();
  });

  it("only links to pages that exist", () => {
    const root = join(process.cwd(), "app/(dashboard)");
    for (const item of NAVIGATION.flatMap((g) => g.items)) {
      const path = item.href.replace(/\?.*$/, "");
      const direct = join(root, path, "page.tsx");
      const dynamic = join(root, path.replace(/\/[^/]+$/, "/[resource]"), "page.tsx");
      expect(existsSync(direct) || existsSync(dynamic), item.href).toBe(true);
    }
  });

  it("has unique names and hrefs", () => {
    const items = NAVIGATION.flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.name)).size).toBe(items.length);
  });
});
