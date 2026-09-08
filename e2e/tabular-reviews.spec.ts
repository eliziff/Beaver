import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const PDF_FIXTURE = path.join(__dirname, "fixtures/test.pdf");

async function createReview(page: Page, label = "E2E Review") {
    await page.goto("/tabular-reviews");
    await expect(page.getByRole("heading", { name: "Tabular Reviews", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New tabular review", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: "Create custom", exact: true }).click();
    await modal.getByRole("button", { name: /Set columns manually/ }).click();
    const title = `${label} ${Date.now()}`;
    await modal.getByRole("textbox", { name: "Review name", exact: true }).fill(title);
    const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/tabular-review" &&
        response.request().method() === "POST");
    await modal.getByRole("button", { name: "Create", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const review = await response.json();
    await expect(page).toHaveURL(new RegExp(`/tabular-reviews/${review.id}$`));
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    return { id: review.id as string, title };
}

test("navigates to /tabular-reviews and the list page renders", async ({ page }) => {
    await page.goto("/tabular-reviews");
    await expect(page).toHaveURL(/\/tabular-reviews$/);
    await expect(page.getByRole("heading", { name: "Tabular Reviews", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "All", exact: true })).toBeVisible();
});

test("creates a new tabular review and is redirected to the detail page", async ({ page }) => {
    const { id, title } = await createReview(page);
    const response = await page.request.get(`/api/tabular-review/${id}`);
    await expect(response).toBeOK();
    expect((await response.json()).review).toMatchObject({ title, workflow_id: null, columns_config: [] });
    await page.reload();
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
});

test("review detail page renders the table structure and toolbar controls", async ({ page }) => {
    await createReview(page, "E2E Table Review");
    await expect(page.getByText("Document", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add columns", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add documents", exact: true })).toBeVisible();
});

test("adds a document to a tabular review and the row persists", async ({ page }) => {
    test.setTimeout(60_000);
    const { id } = await createReview(page, "E2E Doc Review");
    await page.getByRole("button", { name: "Add documents", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: "Upload", exact: true }).click();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Files", exact: true }).click();
    await (await chooserPromise).setFiles(PDF_FIXTURE);
    await modal.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText("test.pdf", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => {
        const response = await page.request.get(`/api/tabular-review/${id}`);
        await expect(response).toBeOK();
        return (await response.json()).documents.map(({ filename }: { filename: string }) => filename);
    }).toContain("test.pdf");
    await page.reload();
    await expect(page.getByText("test.pdf", { exact: true }).first()).toBeVisible();
});
