import { randomUUID } from "node:crypto";
import { test, expect, api, upload, deleteDocument, cleanup, screenshot } from "./browser-fixtures";

test("Tabular Run, single-cell Regenerate, chat design and research import use real UI", async ({ page, request }, info) => {
  test.skip(process.env.BEAVER_BROWSER_LIVE !== "1", "Opt-in live browser lane; ordinary smoke does not call paid providers.");
  const documents: any[] = [], reviewIds: string[] = [];
  let researchId: string | undefined;
  try {
    documents.push(await upload(request, `inventory-${randomUUID()}.txt`, "Harbour Works ordered nine steel brackets. The quoted unit price was CAD 34."));
    const title = `Inventory review ${randomUUID()}`;
    const review = await api(request, "POST", "/api/tabular-review", { title, document_ids: documents.map(doc => doc.id),
      columns_config: [{ index: 0, name: "Quantity", prompt: "How many brackets were ordered?", format: "number" }] });
    reviewIds.push(review.id);
    await page.goto(`/tabular-reviews/${review.id}`);
    await expect(page.locator("[data-tr-col-header]").first()).toContainText("Quantity");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const get = () => api(request, "GET", `/api/tabular-review/${review.id}`);
    await expect.poll(async () => (await get()).cells.map((cell: any) => cell.status), { timeout: 180000 }).toEqual(["done"]);
    await expect(page.getByRole("button", { name: "Open Quantity result", exact: true })).toContainText("9");
    await page.getByRole("button", { name: "Open Quantity result", exact: true }).click();
    const pending = page.waitForResponse(response => response.url().endsWith("/regenerate-cell") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    expect((await pending).status()).toBe(202);
    await expect.poll(async () => (await get()).cells.map((cell: any) => cell.status), { timeout: 180000 }).toEqual(["done"]);
    await page.reload(); await expect(page.getByRole("button", { name: "Open Quantity result", exact: true })).toContainText("9");
    await screenshot(page, info, "tabular-result.png");

    await page.goto("/tabular-reviews");
    await page.getByRole("button", { name: "New tabular review", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: "Create custom", exact: true }).click();
    await modal.getByRole("button", { name: "Chat assist", exact: true }).click();
    await modal.getByLabel("Describe the review", { exact: true }).fill("Compare ordered quantities and unit prices in purchase records.");
    await modal.getByRole("button", { name: "Propose design", exact: true }).click();
    await expect(modal.getByRole("region", { name: "Columns", exact: true }).locator("button[aria-expanded]").first()).toBeVisible({ timeout: 180000 });
    await screenshot(page, info, "tabular-design.png"); await page.keyboard.press("Escape");

    const titleResearch = `Purchase research ${randomUUID()}`;
    let research = await api(request, "POST", "/api/source-workspaces", { title: titleResearch }); researchId = research.document.id;
    for (const document of documents) research = await api(request, "POST", `/api/source-workspaces/${researchId}/actions`, {
      version_id: research.versionId, working_revision: research.workingRevision,
      action: { type: "source", reference: { provider: "library", kind: "document", id: document.id,
        versionId: document.current_version_id, title: document.filename } },
    });
    await page.goto("/tabular-reviews"); await page.getByRole("button", { name: "New tabular review", exact: true }).click();
    await modal.getByRole("button", { name: "Create custom", exact: true }).click();
    await modal.getByRole("button", { name: "Import a Research set", exact: true }).click();
    await modal.getByLabel(new RegExp(`^Select ${titleResearch}`)).check();
    await modal.getByRole("button", { name: "Suggest a table", exact: true }).click();
    await expect(modal.getByRole("button", { name: "Create table", exact: true })).toBeEnabled({ timeout: 180000 });
    const create = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tabular-review" && response.request().method() === "POST");
    await modal.getByRole("button", { name: "Create table", exact: true }).click();
    const imported = await (await create).json(); reviewIds.push(imported.id);
    await expect(page).toHaveURL(new RegExp(`/tabular-reviews/${imported.id}$`));
    expect((await api(request, "GET", `/api/tabular-review/${imported.id}`)).documents.map((doc: any) => doc.id)).toEqual(documents.map(doc => doc.id));
    await screenshot(page, info, "tabular-import.png");
  } finally {
    await cleanup(...reviewIds.map(id => api(request, "DELETE", `/api/tabular-review/${id}`)),
      ...(researchId ? [deleteDocument(request, researchId)] : []), ...documents.map(doc => deleteDocument(request, doc.id)));
  }
});
