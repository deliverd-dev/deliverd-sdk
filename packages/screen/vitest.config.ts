import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "screen",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
