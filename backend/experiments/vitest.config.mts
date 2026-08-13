import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
