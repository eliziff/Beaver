import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  test: {
    environment: "node",
    include: ["experiments/legal-evidence/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
