import { test as base } from "@playwright/test";
export { expect, type Page, type APIResponse } from "@playwright/test";

import { createTestUser, signIn, type TestUser } from "./auth";

type StorageState = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
export const test = base.extend<{ e2eUser: TestUser }, { workerUser: TestUser; workerState: StorageState }>({
  workerUser: [async ({}, use) => {
    if (process.env.BEAVER_E2E_MODE === "local") {
      await use({ email: "", password: "" });
      return;
    }
    const user = await createTestUser();
    try { await use(user); } finally { await user.remove(); }
  }, { scope: "worker" }],
  workerState: [async ({ browser, workerUser }, use) => {
    if (process.env.BEAVER_E2E_MODE === "local") {
      await use({ cookies: [], origins: [] });
      return;
    }
    const context = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    try {
      const page = await context.newPage();
      await signIn(page, workerUser);
      await page.waitForURL(/\/assistant/, { timeout: 15_000 });
      await use(await context.storageState());
    } finally { await context.close(); }
  }, { scope: "worker" }],
  e2eUser: async ({ workerUser }, use) => { await use(workerUser); },
  storageState: async ({ workerState }, use) => { await use(workerState); },
  context: async ({ context }, use, info) => {
    await context.addInitScript(submission => {
      sessionStorage.setItem("beaver.promptSubmission", JSON.stringify(submission));
    }, { origin: "machine_test", run_id: process.env.BEAVER_TEST_RUN_ID!,
      scenario: info.titlePath.join(" / ").slice(0, 300) });
    await use(context);
  },
});
