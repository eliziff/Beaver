import { test, expect, type Page } from "@playwright/test";
import { createProject, PDF_FIXTURE } from "./fixtures/project";

test.describe.configure({ timeout: 60_000 });

async function gotoProjectRow(
    page: Page,
    projectName: string,
) {
    // Exclude the sidebar, which can also display the project name.
    const row = page.locator("div.group").filter({ hasText: projectName });
    await page.goto("/projects");
    await expect(row.first()).toBeVisible({ timeout: 12_000 });
    return row;
}

test("rename a project via Edit details", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    await createProject(page, projectName);
    const projectId = new URL(page.url()).pathname.split("/")[2];

    const row = await gotoProjectRow(page, projectName);

    const ellipsisBtn = row.getByRole("button", { name: "More actions", exact: true });
    await ellipsisBtn.click();

    await page.getByRole("menuitem", { name: "Edit details", exact: true }).click();

    const newName = `E2E Proj Renamed ${Date.now()}`;
    const renameInput = page.locator("#project-details-name");
    await expect(renameInput).toBeVisible({ timeout: 10_000 });
    await renameInput.fill(newName);

    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect.poll(async () => {
        const response = await page.request.get(`/api/projects/${projectId}`);
        await expect(response).toBeOK();
        return (await response.json()).name;
    }).toBe(newName);
    await page.keyboard.press("Escape");
    await page.reload();

    await expect(
        page.locator("div.group").filter({ hasText: newName }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
        page.locator("div.group").filter({ hasText: projectName }),
    ).toHaveCount(0);
});

test("delete a project", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    await createProject(page, projectName);
    const projectId = new URL(page.url()).pathname.split("/")[2];

    const row = await gotoProjectRow(page, projectName);
    const checkbox = row.locator('input[type="checkbox"]');
    await checkbox.click();

    const actionsBtn = page.getByRole("button", { name: "More actions for selected projects", exact: true });
    await expect(actionsBtn).toBeVisible({ timeout: 3_000 });
    await actionsBtn.click();

    const deleteBtn = page.getByRole("menuitem", { name: "Delete", exact: true });
    await expect(deleteBtn).toBeVisible({ timeout: 3_000 });

    await deleteBtn.click();
    const confirmation = page.getByRole("alertdialog", { name: "Delete project?", exact: true });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toBeVisible();
    await expect(await page.request.get(`/api/projects/${projectId}`)).toBeOK();
    await actionsBtn.click();
    await deleteBtn.click();
    await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(
        page.locator("div.group").filter({ hasText: projectName }),
    ).toHaveCount(0, { timeout: 10_000 });
    expect((await page.request.get(`/api/projects/${projectId}`)).status()).toBe(404);
});

test("create a folder inside a project", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;

    // Exercise folder creation in a populated document tree.
    await createProject(page, projectName, PDF_FIXTURE);

    const addSubfolderBtn = page.getByRole("button", { name: "New folder", exact: true });
    await expect(addSubfolderBtn).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("test.pdf").first()).toBeVisible({
        timeout: 10_000,
    });

    await addSubfolderBtn.click();

    const folderInput = page.getByPlaceholder("Folder name");
    await expect(folderInput).toBeVisible({ timeout: 3_000 });

    const folderName = `Test Folder ${Date.now()}`;
    await folderInput.fill(folderName);
    await folderInput.press("Enter");

    await expect(page.getByText(folderName)).toBeVisible({ timeout: 10_000 });
});

test("file upload type validation — .exe file is rejected", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    await createProject(page, projectName);

    const addDocsBtn = page.getByRole("button", { name: "Upload", exact: true });
    await expect(addDocsBtn).toBeVisible({ timeout: 15_000 });

    const projectId = page.url().match(/\/projects\/([0-9a-f-]{36})/)?.[1];
    expect(projectId, "expected to be on a /projects/<id> page").toBeTruthy();
    // Exercise server rejection separately: the UI rejects this file before sending it.
    const uploadResponse = await page.request.post(
        `/api/projects/${projectId}/documents`,
        {
            multipart: {
                file: {
                    name: "test.exe",
                    mimeType: "application/octet-stream",
                    buffer: Buffer.from(
                        "This is a plain text file that should be rejected.",
                    ),
                },
            },
        },
    );
    expect(uploadResponse.status()).toBe(400);

    await addDocsBtn.click();
    await page.getByRole("menuitem", { name: "Files", exact: true }).click();

    await page.getByRole("dialog").getByRole("button", { name: "Upload", exact: true }).click();
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Files", exact: true }).click();
    const fileChooser = await fileChooserPromise;

    // Bypass the browser accept attribute to test application validation.
    await fileChooser.setFiles({
        name: "test.exe",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("This is a plain text file that should be rejected."),
    });

    await expect(
        page.getByText(
            /Unsupported file type/,
        ),
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText("test.exe")).not.toBeVisible();
});
