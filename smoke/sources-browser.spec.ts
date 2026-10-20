import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, ImageRun, Packer, PageBreak, Paragraph } from "docx";
import { test, expect, api, upload, deleteDocument, cleanup, screenshot } from "./browser-fixtures";

test("source tabs release inactive readers and restore their reading position", async ({ page, request }, info) => {
  const documents: any[] = [];
  let chatId: string | undefined;
  try {
    const run = randomUUID();
    for (let index = 0; index < 6; index++) {
      const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
      for (let number = 1; number <= 24; number++) pdf.addPage([612, 792]).drawText(
        `Invented garden survey ${index + 1}, page ${number}`, { x: 50, y: 700, size: 18, font });
      const response = await request.post("/api/library/files/documents", { multipart: { file: {
        name: `garden-${run}-${index}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()),
      } } });
      expect(response.status()).toBe(201); documents.push(await response.json());
    }
    const word = new Document({ sections: [{ children: [new Paragraph({ children: [new ImageRun({
      type: "png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64"),
      transformation: { width: 40, height: 40 },
    })] }), ...Array.from({ length: 6 }, (_, index) => [new Paragraph({ children: [new PageBreak()] }),
      new Paragraph(`Invented orchard plan ${index + 1}`)]).flat()] }] });
    const response = await request.post("/api/library/files/documents", { multipart: { file: {
      name: `orchard-${run}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await Packer.toBuffer(word),
    } } });
    expect(response.status()).toBe(201); documents.push(await response.json());
    chatId = (await api(request, "POST", "/api/chat/create", {})).id;
    await page.addInitScript(values => {
      sessionStorage.setItem("beaver:new-chat-documents", JSON.stringify(values));
      const live = new Set<string>(), make = URL.createObjectURL, revoke = URL.revokeObjectURL;
      (window as any).readerObjectUrls = live;
      URL.createObjectURL = function (blob) { const url = make.call(URL, blob); live.add(url); return url; };
      URL.revokeObjectURL = function (url) { live.delete(url); revoke.call(URL, url); };
    }, documents);
    const readerRequests = new Set<string>();
    page.on("request", request => {
      const id = new URL(request.url()).pathname.match(/\/single-documents\/([^/]+)\/reader-text$/u)?.[1];
      if (id) readerRequests.add(id);
    });
    await page.goto(`/assistant/chat/${chatId}`);
    const dock = page.locator("[data-assistant-dock]"), tabs = dock.getByRole("tablist", { name: "Open sources" });
    await expect(tabs.getByRole("tab")).toHaveCount(documents.length);
    await expect(dock.locator(".docx-view-container .docx").first()).toBeVisible();
    const media = await dock.locator(".docx-view-container img").evaluateAll(images => images.map(image => (image as HTMLImageElement).src));
    expect(media.length).toBeGreaterThan(0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage"), dom = await cdp.send("Memory.getDOMCounters");
    const readers = { pdf: await dock.locator(".pdfViewer").count(), word: await dock.locator(".docx-view-container").count() };
    const receipt = info.outputPath("reader-memory.json");
    await writeFile(receipt, JSON.stringify({ heap, dom, readers }));
    await info.attach("reader-memory.json", { path: receipt, contentType: "application/json" });
    await cdp.detach();
    await screenshot(page, info, "source-word.png");
    expect(readers).toEqual({ pdf: 0, word: 1 });
    expect([...readerRequests]).toEqual([documents.at(-1).id]);
    const wordScroll = dock.locator(".docx-view-scroll");
    await expect.poll(() => wordScroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(800);
    await wordScroll.evaluate(element => { element.scrollTop = 800; element.dispatchEvent(new Event("scroll")); });
    const wordTop = await wordScroll.evaluate(element => element.scrollTop);
    expect(wordTop).toBeGreaterThan(500);
    await tabs.getByRole("tab", { name: documents[0].filename, exact: true }).click();
    await expect(dock.locator(".pdfViewer canvas").first()).toBeVisible();
    await expect.poll(() => page.evaluate(urls => urls.every(url => !(window as any).readerObjectUrls.has(url)), media)).toBe(true);
    const scroll = dock.locator(".pdfViewer").locator("..");
    await dock.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(dock.getByText("125%", { exact: true })).toBeVisible();
    await scroll.evaluate(element => { element.scrollTop = 2600; element.dispatchEvent(new Event("scroll")); });
    const pdfTop = await scroll.evaluate(element => element.scrollTop);
    await tabs.getByRole("tab", { name: documents[1].filename, exact: true }).click();
    await expect(dock.locator(".pdfViewer")).toHaveCount(1);
    await expect(dock.locator(".docx-view-container")).toHaveCount(0);
    await tabs.getByRole("tab", { name: documents[0].filename, exact: true }).click();
    await expect(dock.getByText("125%", { exact: true })).toBeVisible();
    await expect.poll(() => scroll.evaluate((element, top) => Math.abs(element.scrollTop - top), pdfTop)).toBeLessThan(8);
    await screenshot(page, info, "source-pdf-restored.png");
    await dock.getByRole("button", { name: "Collapse assistant dock", exact: true }).click();
    await expect(dock.locator(".pdfViewer")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand assistant dock", exact: true }).click();
    await expect.poll(() => scroll.evaluate((element, top) => Math.abs(element.scrollTop - top), pdfTop)).toBeLessThan(8);
    await tabs.getByRole("tab", { name: documents.at(-1).filename, exact: true }).click();
    await expect.poll(() => wordScroll.evaluate((element, top) => Math.abs(element.scrollTop - top), wordTop)).toBeLessThan(8);
    await screenshot(page, info, "source-word-restored.png");
  } finally {
    await page.goto("about:blank");
    await cleanup(...(chatId ? [api(request, "DELETE", `/api/chat/${chatId}`)] : []),
      ...documents.map(document => deleteDocument(request, document.id)));
  }
});

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
      action: { type: "passage", sourceId: source.id, revision: reader.revision, ranges: [{ start: 0, end: 51 }] },
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
    await page.getByText("Court Records", { exact: true }).locator("..").locator("..")
      .getByRole("button", { name: "Choose folder", exact: true }).click();
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
