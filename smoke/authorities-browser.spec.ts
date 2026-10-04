import { test, expect, ownedBrowserRecords, files, screenshot, type Page, type TestInfo } from "./browser-fixtures";

async function pick(page: Page, label: string, inputs: string[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: label, exact: true }).click();
  await (await chooser).setFiles(inputs);
}
async function importBrief(page: Page, input: string) {
  await page.goto("/table-of-authorities");
  await pick(page, "Add file", [input]);
  const wizard = page.getByRole("dialog").filter({ has: page.getByRole("list", { name: "Import steps" }) });
  await wizard.getByRole("button", { name: /^Court:/ }).click();
  const courts = page.getByRole("dialog").filter({ has: page.getByLabel("Search courts") });
  await courts.getByLabel("Search courts").fill("Court of Appeal of Alberta");
  await courts.getByRole("button", { name: /Court of Appeal of Alberta/ }).click();
  await wizard.getByRole("button", { name: "Marking", exact: true }).click();
  await wizard.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Citations" })).toBeVisible({ timeout: 120000 });
  return new URL(page.url()).searchParams.get("draft")!;
}
async function downloadOutputs(page: Page, info: TestInfo) {
  await page.getByRole("tab", { name: "Build book", exact: true }).click();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  const controls = page.getByRole("button", { name: /^Download / });
  await expect(controls.first()).toBeVisible({ timeout: 120000 });
  const paths: string[] = [];
  for (const button of await controls.all()) {
    const pending = page.waitForEvent("download");
    await button.click();
    const download = await pending, target = info.outputPath(download.suggestedFilename());
    await download.saveAs(target); paths.push(target);
  }
  return paths;
}

test("Authorities imports native DOCX, refocuses persisted review and downloads a valid table", async ({ page, request }, info) => {
  const input = files("authorities-fixtures", info.outputPath("inputs"));
  const remove = ownedBrowserRecords(page, request);
  try {
    await importBrief(page, input.source);
    const citations = page.getByRole("listbox", { name: "Citations" });
    for (const citation of ["2009 SCC 32", "2016 SCC 27", "2026 SCC 16", "2021 BCCA 222"])
      await expect(citations.getByRole("option").filter({ hasText: citation }).first()).toBeVisible();
    const option = citations.getByRole("option").filter({ hasText: "2009 SCC 32" }).first();
    await option.click();
    await expect(page.locator(".docx-view-container [data-citation-id][data-active]").first()).toBeVisible();
    await screenshot(page, info, "docx-review.png");
    await page.reload();
    await citations.getByRole("option").filter({ hasText: "2016 SCC 27" }).first().click();
    await expect(page.locator(".docx-view-container [data-citation-id][data-active]").first()).toBeVisible();
    const paths = await downloadOutputs(page, info);
    const table = paths.find(file => file.endsWith(".docx"));
    expect(table).toBeTruthy();
    files("table", info.outputPath("inspection"), table!);
  } finally { await remove(); }
});

test("Authorities native PDF review and attached source preview survive reopening and export a valid book", async ({ page, request }, info) => {
  const input = files("authorities-fixtures", info.outputPath("inputs"));
  const remove = ownedBrowserRecords(page, request);
  try {
    await importBrief(page, input.filing);
    await page.getByRole("listbox", { name: "Citations" }).getByRole("option").filter({ hasText: "2009 SCC 32" }).first().click();
    await expect(page.locator(".pdf-text-layer [data-citation-id][data-active]").first()).toBeVisible();
    await screenshot(page, info, "pdf-review.png");

    await page.goto("/table-of-authorities");
    await page.getByRole("tab", { name: "Manual", exact: true }).click();
    await page.getByLabel("Book title", { exact: true }).fill("Book of Authorities");
    await pick(page, "Add files", input.pdfs.slice(0, 2));
    const rows = page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem");
    await expect(rows).toHaveCount(2, { timeout: 120000 });

    const open = rows.first().getByRole("button", { name: /^View PDF for/ });
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "PDF page", exact: true })).toHaveValue("1");
    await expect(dialog.locator("canvas").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(open).toBeFocused();
    await page.reload();
    await rows.first().getByRole("button", { name: /^View PDF for/ }).click();
    await expect(dialog.getByRole("textbox", { name: "PDF page", exact: true })).toHaveValue("1");
    await screenshot(page, info, "source-reopened.png");
    await page.keyboard.press("Escape");
    const outputs = await downloadOutputs(page, info);
    const book = outputs.find(file => file.endsWith(".pdf"));
    expect(book).toBeTruthy(); files("book", info.outputPath("inspection"), book!);
  } finally { await remove(); }
});
