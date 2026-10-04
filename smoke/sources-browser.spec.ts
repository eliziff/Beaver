import { randomUUID } from "node:crypto";
import { test, expect, api, upload, deleteDocument, cleanup, screenshot } from "./browser-fixtures";

test("Sources explicit version-bound membership, organization review and undo", async ({ page, request }, info) => {
  let document: any, research: any, id: string | undefined, chatId: string | undefined;
  try {
    document = await upload(request, `source-${randomUUID()}.txt`, "A lighthouse inspection found clear visibility. The repair estimate was recorded separately.");
  const title = `Browser collection ${randomUUID()}`;
  research = await api(request, "POST", "/api/source-workspaces", { title });
  id = research.document.id;
  const get = () => api(request, "GET", `/api/source-workspaces/${id}`);
    await page.goto("/library");
    const row = page.locator("[data-document-row]").filter({ hasText: document.filename });
    await page.setViewportSize({ width: 390, height: 850 });
    await row.getByRole("button", { name: `View ${document.filename}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("lighthouse inspection");
    await screenshot(page, info, "library-narrow-preview.png");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await row.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add to research…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Search research sets").fill(title);
    await dialog.getByLabel(`Select ${title}`, { exact: true }).check();
    expect(Object.values((await get()).state.sources)).toHaveLength(0);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(async () => Object.values((await get()).state.sources).filter((source: any) => source.collected)).toHaveLength(1);
    let saved = await get();
    const source: any = Object.values(saved.state.sources)[0];
    expect(source.reference).toMatchObject({ id: document.id, versionId: document.current_version_id });
    expect(source.labelIds).toEqual([]);
    expect((await api(request, "GET", `/api/source-workspaces/${id}/items?kind=passages`)).items).toEqual([]);
    const reader = await api(request, "GET", `/api/single-documents/${document.id}/reader-text?version_id=${document.current_version_id}`);
    saved = await api(request, "POST", `/api/source-workspaces/${id}/actions`, {
      version_id: saved.versionId, working_revision: saved.workingRevision,
      action: { type: "passage", sourceId: source.id, revision: reader.revision, start: 0, end: 51 },
    });
    await page.goto(`/sources?research_file=${id}`);
    const rail = page.getByRole("region", { name: "Research collection" });
    await expect(rail.getByRole("tree", { name: "Sources", exact: true })).toBeVisible();
    await expect(rail.getByRole("treeitem", { name: document.filename, exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const choice = page.getByLabel("Workspace chat", { exact: true });
    await expect.poll(() => choice.inputValue()).not.toBe("");
    chatId = await choice.inputValue();
    const leafId = randomUUID();
    await api(request, "POST", `/api/source-workspaces/${id}/labels/preview`, { conversationId: chatId,
      design: { title: "Inspection findings", sourceLabels: [{ id: randomUUID(), name: "Visibility", members: [source.id],
        children: [{ id: leafId, name: "Clear", members: [], children: [] }] }], highlightTypes: [] } });
    await page.reload();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(dialog.getByRole("tree", { name: "Sources", exact: true })).toBeVisible();
    await screenshot(page, info, "organization-review.png");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    expect((await get()).state.labels).toEqual(saved.state.labels);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const child = dialog.locator(`[data-label-select="${leafId}"]`);
    await dialog.getByRole("button", { name: "Collapse Visibility", exact: true }).click();
    await expect(child).not.toBeVisible();
    await dialog.getByRole("button", { name: "Expand Visibility", exact: true }).click();
    await expect(child).toBeVisible();
    await dialog.getByRole("button", { name: "Accept changes", exact: true }).click();
    await expect.poll(async () => (await get()).state.labels[leafId]?.name).toBe("Clear");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => (await get()).state.labels).toEqual(saved.state.labels);
    await screenshot(page, info, "sources-undone.png");
  } finally {
    await cleanup(...(chatId ? [api(request, "DELETE", `/api/chat/${chatId}`)] : []),
      ...(id ? [deleteDocument(request, id)] : []), ...(document ? [deleteDocument(request, document.id)] : []));
  }
});

test("Settings folder chooser creates nested folders and saves the selected output target", async ({ page, request }, info) => {
  const original = (await api(request, "GET", "/api/user/profile")).workflowFileTargets;
  const created: any[] = [];
  try {
    await page.goto("/sources"); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByLabel("Folder name", { exact: true }).fill("Cancelled");
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Folder name", { exact: true })).not.toBeVisible();
    for (const name of [`Browser folders ${randomUUID()}`, "Nested output"]) {
      await page.getByRole("button", { name: "New folder", exact: true }).click();
      await page.getByLabel("Folder name", { exact: true }).fill(name);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/library/files/folders" && response.request().method() === "POST");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const response = await saved; expect(response.ok()).toBe(true); created.push(await response.json());
      await expect(page.getByLabel("Choose destination folder").getByText(name, { exact: true })).toBeVisible();
    }
    expect(created[0].parent_folder_id).toBeNull(); expect(created[1].parent_folder_id).toBe(created[0].id);
    await page.getByRole("button", { name: "Use folder", exact: true }).click();
    await expect.poll(async () => (await api(request, "GET", "/api/user/profile")).workflowFileTargets["court-records"]).toEqual({ kind: "library", folderId: created[1].id });
    await screenshot(page, info, "output-folder.png");
  } finally {
    const failed: unknown[] = [];
    try {
      const current = (await api(request, "GET", "/api/user/profile")).workflowFileTargets;
      if (created.some(folder => folder.id === current["court-records"]?.folderId))
        await api(request, "PATCH", "/api/user/profile", { workflowFileTargets: { ...current, "court-records": original["court-records"] } });
    } catch (error) { failed.push(error); }
    // Children must go first, but one failed deletion must not leave other owned folders unattempted.
    for (const folder of created.reverse()) try { await api(request, "DELETE", `/api/library/files/folders/${folder.id}`); } catch (error) { failed.push(error); }
    if (failed.length) throw new AggregateError(failed, "Folder cleanup failed");
  }
});
