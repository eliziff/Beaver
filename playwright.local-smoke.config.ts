import { defineConfig, devices } from "@playwright/test";

// This lane never starts or reuses a development server. Run it only through
// `scripts/mike.ps1 smoke -Full -WithTableOfAuthorities`, after that launcher
// has proved ownership of the production listeners.
export default defineConfig({
    testDir: "./smoke",
    testMatch: /local-production-smoke\.spec\.ts/,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 180_000,
    expect: { timeout: 15_000 },
    reporter: "list",
    outputDir: "test-results/local-production-smoke",
    use: {
        baseURL: "http://127.0.0.1:3000",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "off",
    },
    projects: [
        {
            name: "local-production",
            use: devices["Desktop Chrome"],
        },
    ],
});
