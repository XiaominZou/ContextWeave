import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@ctx/adapter-kit/testing", replacement: resolve(__dirname, "packages/adapter-kit/src/testing/index.ts") },
      { find: "@ctx/adapter-kit", replacement: resolve(__dirname, "packages/adapter-kit/src/index.ts") },
      { find: "@ctx/core", replacement: resolve(__dirname, "packages/core/src/index.ts") },
      { find: "@ctx/client", replacement: resolve(__dirname, "packages/client/src/index.ts") },
      { find: "@ctx/testing", replacement: resolve(__dirname, "packages/testing/src/index.ts") },
      { find: "@ctx/adapter-opencode", replacement: resolve(__dirname, "packages/adapter-opencode/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/**/src/**/__tests__/**/*.test.ts"],
    coverage: {
      enabled: false,
    },
  },
});
