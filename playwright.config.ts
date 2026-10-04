import { constants, setPriority } from "node:os";
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { localData } from "./e2e/local-data.cjs";

process.env.BEAVER_TEST_RUN_ID ??= `playwright-${randomUUID()}`;
process.env.BEAVER_E2E_MODE ??= "local";
const localSmoke = process.env.BEAVER_E2E_MODE === "local";

/**
 * Run `npx playwright install` to download the browsers.
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
    testDir: "./e2e",
    ...(localSmoke && !process.env.CI ? { globalTeardown: "./e2e/local-data.cjs" } : {}),
    // Cloud tests own distinct accounts; local mode has one configured backend owner.
    fullyParallel: !localSmoke,
    workers: localSmoke || !process.env.CI ? 1 : 2,
    /* Fail the build on CI if you accidentally left test.only in the source */
    forbidOnly: !!process.env.CI,
    retries: 0,
    /* Reporter */
    reporter: process.env.CI ? "github" : "list",
    /* Shared settings for all the projects below */
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },

    projects: localSmoke ? [{
        name: "local-chromium",
        testMatch: ["assistant-interface.spec.ts", "chat-management.spec.ts", "project-management.spec.ts", "workflows-account.spec.ts", "tabular-reviews.spec.ts"],
        use: { ...devices["Desktop Chrome"] },
    }] : [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],

    // The explicit cloud launcher supplies stack configuration through inherited env.
    webServer: process.env.CI
        ? undefined
        : [
              {
                  command:
                      localSmoke ? "node ../e2e/local-data.cjs prepare && npm run dev" : "npm run dev",
                  ...(localSmoke ? { env: { AUTH_MODE: "local", MIKE_LOCAL_DATA_DIR: localData, OPEN_LEGAL_DATA_HOME: localData } } : {}),
                  cwd: "backend",
                  url: "http://localhost:3001/api/health",
                  reuseExistingServer: false,
                  timeout: 120_000,
              },
              {
                  command: "npm run dev",
                  cwd: "frontend",
                  url: "http://localhost:3000",
                  reuseExistingServer: false,
                  timeout: 120_000,
              },
          ],
});
