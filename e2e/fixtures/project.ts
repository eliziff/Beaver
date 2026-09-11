import { expect, type Page } from "@playwright/test";
import path from "node:path";

export const PDF_FIXTURE = path.join(__dirname, "test.pdf");

export async function createProject(
    page: Page,
    projectName: string,
    filePath?: string,
) {
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/, { timeout: 10_000 });

    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(projectName);

    await page.getByRole("button", { name: "Next", exact: true }).click();

    if (filePath) {
        await page.getByRole("button", { name: "Upload", exact: true }).click();
        const fileChooserPromise = page.waitForEvent("filechooser");
        await page.getByRole("menuitem", { name: "Files", exact: true }).click();
        await (await fileChooserPromise).setFiles(filePath);
        await expect(
            page.getByRole("list", { name: "Files ready to upload" }).getByText(path.basename(filePath)),
        ).toBeVisible({ timeout: 5_000 });
    }

    const navTimeout = filePath ? 30_000 : 15_000;
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/projects\/[^/]+$/, { timeout: navTimeout });
}
