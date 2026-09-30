import { test as base } from "@playwright/test";
export { expect, type Page, type APIResponse } from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use, info) => {
    await context.addInitScript(submission => {
      sessionStorage.setItem("beaver.promptSubmission", JSON.stringify(submission));
    }, { origin: "machine_test", run_id: process.env.BEAVER_TEST_RUN_ID!,
      scenario: info.titlePath.join(" / ").slice(0, 300) });
    await use(context);
  },
});
