import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            {
                find: "docx-preview",
                replacement: resolvePath(
                    "./vendor/docx-preview/index.ts",
                ),
            },
            {
                find: /^@\/(.*)$/,
                replacement: resolvePath("./src/$1"),
            },
        ],
    },
    test: {
        globals: true,
        pool: "forks",
        isolate: false,
        maxWorkers: 4,
        execArgv: ["--max-old-space-size=192"],
        silent: "passed-only",
        environment: "jsdom",
        setupFiles: ["./vitest.setup.ts"],
        include: ["src/**/*.test.{ts,tsx}"],
        exclude: ["node_modules/**", "e2e/**", "**/*.spec.ts"],
        testTimeout: 20000,
        hookTimeout: 20000,
    },
});
