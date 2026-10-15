import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sdk",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
