import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@of/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts", "packages/plugin/src/main.ts", "packages/plugin/src/view.ts", "packages/plugin/src/modelsview.ts", "packages/server/src/main.ts", "packages/worker/src/main.ts", "**/*.d.ts"],
      reporter: ["text-summary", "text"],
      thresholds: {
        "packages/core/src/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
