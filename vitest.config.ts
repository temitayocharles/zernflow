import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      "server-only": resolve(__dirname, "lib/test/server-only.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
    environment: "node",
  },
});
