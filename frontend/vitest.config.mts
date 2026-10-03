import { constants, setPriority } from "node:os";
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const resolvePath = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
    // Production builds/browser tests cover the React Compiler; unit tests need JSX only.
    plugins: [react()],
    server: { fs: { allow: [resolvePath(".."), realpathSync(resolvePath("./node_modules"))] } },
    resolve: {
        alias: [
            { find: /^(?:mike\/|.*\/)shared\/runtime\/(.*)\.mjs$/, replacement: resolvePath("../shared/contracts/$1.mts") },
            { find: /^mike\/shared\/(.*)$/, replacement: resolvePath("../shared/$1") },
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
        pool: "threads",
        maxWorkers: process.env.CI ? 4 : 1,
        silent: "passed-only",
        environment: "jsdom",
        setupFiles: ["./vitest.setup.ts"],
        include: ["src/**/*.test.{ts,tsx}"],
        exclude: ["node_modules/**", "e2e/**", "**/*.spec.ts"],
        testTimeout: process.env.CI ? 20000 : 60000,
        hookTimeout: process.env.CI ? 20000 : 60000,
    },
});
