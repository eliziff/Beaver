import { selectedTests } from "../scripts/focused-tests.mjs";
import { constants, setPriority } from "node:os";
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
    server: { fs: { allow: [resolvePath("..")] } },
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
        maxWorkers: 1,
        silent: "passed-only",
        environment: "node",
        setupFiles: ["./vitest.setup.ts"],
        include: selectedTests(),
        exclude: ["node_modules/**", "e2e/**", "**/*.spec.ts"],
        testTimeout: process.env.CI ? 20000 : 60000,
        hookTimeout: process.env.CI ? 20000 : 60000,
    },
});
