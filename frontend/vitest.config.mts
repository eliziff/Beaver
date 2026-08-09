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
        environment: "jsdom",
        setupFiles: ["./vitest.setup.ts"],
        // Supabase validates these at import; unit tests never connect.
        env: {
            NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY: "test-anon-key",
        },
        include: ["src/**/*.test.{ts,tsx}"],
        exclude: ["node_modules/**", "e2e/**", "**/*.spec.ts"],
        testTimeout: 20000,
        hookTimeout: 20000,
    },
});
