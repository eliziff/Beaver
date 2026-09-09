import { test, expect, type Page } from "@playwright/test";

async function createWorkflow(page: Page, title: string) {
    await page.goto("/workflows");
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("textbox", { name: "Workflow name", exact: true }).fill(title);
    await modal.getByRole("textbox", { name: "What it produces", exact: true }).fill("A concise summary");
    await modal.getByRole("textbox", { name: "Instructions", exact: true }).fill("Summarize the selected document.");
    const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/workflows" && response.request().method() === "POST");
    await modal.getByRole("button", { name: "Create workflow", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const workflow = await response.json();
    await expect(page).toHaveURL(new RegExp(`/workflows/${workflow.id}$`));
    await expect(page.locator("header").getByRole("heading", { name: title, exact: true })).toBeVisible();
    return workflow.id as string;
}

test.describe("Workflows", () => {
    test("create a custom assistant workflow and navigate to its detail page", async ({ page }) => {
        const title = `E2E Workflow ${Date.now()}`;
        const id = await createWorkflow(page, title);
        const response = await page.request.get(`/api/workflows/${id}`);
        await expect(response).toBeOK();
        expect((await response.json()).metadata.title).toBe(title);
        await page.reload();
        await expect(page.locator("header").getByRole("heading", { name: title, exact: true })).toBeVisible();
    });

    test("built-in workflow information is read-only and edits are refused", async ({ page }) => {
        const before = await page.request.get("/api/workflows/legal-research");
        await expect(before).toBeOK();
        const workflow = await before.json();
        expect(workflow.is_system).toBe(true);
        await page.goto("/workflows/legal-research");
        await expect(page).toHaveURL(/\/workflows\?workflow=legal-research$/);
        await page.getByRole("button", { name: "Info about Research a legal issue", exact: true }).click();
        const modal = page.getByRole("dialog", { name: "Research a legal issue", exact: true });
        await expect(modal).toBeVisible();
        await expect(modal.getByRole("textbox")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Research a legal issue actions", exact: true })).toHaveCount(0);
        const edit = await page.request.patch("/api/workflows/legal-research", {
            data: { metadata: { ...workflow.metadata, title: "Unauthorized change" } },
        });
        expect(edit.status()).toBe(403);
        const after = await page.request.get("/api/workflows/legal-research");
        await expect(after).toBeOK();
        expect(await after.json()).toEqual(workflow);
    });

    test("editing custom workflow instructions saves on blur and survives reload", async ({ page }) => {
        const id = await createWorkflow(page, `E2E Edit Workflow ${Date.now()}`);
        const instructions = `Summarize the key dates. ${Date.now()}`;
        const editor = page.getByRole("textbox", { name: "Workflow instructions", exact: true });
        await expect(editor).toBeEditable();
        await editor.fill(instructions);
        await editor.press("Tab");
        await expect.poll(async () => {
            const response = await page.request.get(`/api/workflows/${id}`);
            await expect(response).toBeOK();
            return (await response.json()).launcher.variants[0].skill_md;
        }).toBe(instructions);
        await page.reload();
        await expect(editor).toHaveValue(instructions);
    });
});

test.describe("Account Settings", () => {
    test("updating display name saves and persists across navigation", async ({ page }) => {
        const loaded = page.waitForResponse((response) =>
            new URL(response.url()).pathname === "/api/user/profile" &&
            response.request().method() === "GET" && response.ok());
        await page.goto("/account");
        await loaded;
        const name = `E2E Test User ${Date.now()}`;
        const input = page.getByRole("textbox", { name: "Display name", exact: true });
        await input.fill(name);
        await page.locator("form").filter({ has: input })
            .getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(async () => {
            const response = await page.request.get("/api/user/profile");
            await expect(response).toBeOK();
            return (await response.json()).displayName;
        }).toBe(name);
        await page.goto("/assistant");
        await page.goto("/account");
        await expect(input).toHaveValue(name);
    });

});
