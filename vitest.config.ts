import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/cli/vitest.config.ts", "packages/sdk/vitest.config.ts", "packages/screen/vitest.config.ts"],
  },
});
