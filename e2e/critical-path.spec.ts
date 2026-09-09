import { test, expect, type Page } from "@playwright/test";
import { hasLlmKey, LLM_SKIP_REASON } from "./llm";
import { createProject, PDF_FIXTURE } from "./fixtures/project";

const CLAUDE_MODEL_LABEL = "Claude Sonnet 4.6";

async function selectClaudeModel(page: Page) {
    const model = page.getByRole("button", { name: /^Model:/ }).first();
    await model.click();
    await page.getByRole("tab", { name: "Anthropic", exact: true }).click();
    await page
        .getByRole("button", { name: CLAUDE_MODEL_LABEL, exact: true })
        .click();
    await expect(model).toHaveAccessibleName(`Model: ${CLAUDE_MODEL_LABEL}`);
}

test("create project, upload PDF, ask a question and receive a response", async ({
    page,
}) => {
    // This remains opt-in; refactoring must not turn a keyless run into a model call.
    test.skip(!hasLlmKey, LLM_SKIP_REASON);

    test.setTimeout(120_000);

    await createProject(page, `E2E Test Project ${Date.now()}`, PDF_FIXTURE);

    const projectUrl = page.url().split("?")[0];
    const createNew = page.getByRole("button", { name: "Create", exact: true });
    await page.goto(`${projectUrl}/assistant`);

    await expect(createNew).toBeVisible({ timeout: 20_000 });
    await createNew.click();

    await page.waitForURL(/\/projects\/.+\/assistant/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

    const chatInput = page.getByPlaceholder("How can I help?");
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    await selectClaudeModel(page);
    await chatInput.fill("What is this document about?");

    await chatInput.press("Enter");

    const assistantAnswer = page
        .locator("div.prose.font-serif.text-gray-900")
        .first();
    await expect(assistantAnswer).toBeVisible({ timeout: 60_000 });

    await expect(assistantAnswer).toContainText(/\S/);
});
