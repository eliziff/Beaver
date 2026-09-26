import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { verifyExport } from "../shared/export-integrity.mjs";

test("recovers a pending upload after reload and publishes one document", async ({ page, request }, info) => {
  const filename = `recovery-${randomUUID()}.txt`, bytes = Buffer.from("Synthetic upload recovery record.");
  const input = { client_key: randomUUID(), filename, size_bytes: bytes.length,
    source_sha256: createHash("sha256").update(bytes).digest("hex") };
  const started = await request.post("/api/uploads", { data: input });
  expect(started.status()).toBe(201);
  const session = await started.json();
  let documentId: string | undefined;
  try {
    await page.goto("/library");
    await page.reload();
    await page.getByRole("button", { name: "Uploads", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Uploads" });
    await dialog.getByLabel(`Select original file for ${filename}`).setInputFiles({ name: filename,
      mimeType: "text/plain", buffer: bytes });
    await expect(dialog.getByRole("listitem").filter({ hasText: filename })).toContainText("Uploaded", { timeout: 60_000 });
    const completed = await (await request.get(`/api/uploads/${session.id}`)).json();
    documentId = completed.document.id;
    const retried = await (await request.post("/api/uploads", { data: input })).json();
    expect(retried.id).toBe(session.id);
    expect(retried.document.id).toBe(documentId);
    await page.screenshot({ path: info.outputPath("uploads.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  } finally {
    await request.delete(`/api/uploads/${session.id}`);
    const latest = await (await request.get(`/api/uploads/${session.id}`)).json();
    if (latest.document) {
      const document = latest.document;
      expect((await request.delete(`/api/single-documents/${document.id}`, { data: {
        expected_current_version_id: document.current_version_id,
        expected_working_revision: document.current_working_revision,
        expected_project_id: document.project_id, expected_folder_id: document.folder_id ?? null,
      } })).ok()).toBe(true);
    }
  }
});

test("project memory persists, rejects stale saves, and exports verifiable metadata", async ({ request }) => {
  const response = await request.post("/api/projects", { data: { name: `Smoke ${randomUUID()}` } });
  expect(response.status()).toBe(201);
  const project = await response.json(), path = `/api/memory/projects/${project.id}`;
  try {
    const initial = await (await request.get(path)).json();
    expect(initial.enabled).toBe(false);
    const saved = await request.patch(path, { data: { revision: initial.revision, enabled: true, content: "Synthetic matter uses Canadian English." } });
    expect(saved.ok()).toBe(true);
    const current = await saved.json();
    expect((await request.patch(path, { data: { revision: initial.revision, content: "Stale edit" } })).status()).toBe(409);
    expect(await (await request.get(path)).json()).toMatchObject({ enabled: true, content: current.content });
    const exported = await request.get(`/api/exports/projects/${project.id}`);
    expect(exported.ok()).toBe(true);
    const envelope = await exported.json();
    expect(() => verifyExport(envelope)).not.toThrow();
    expect(() => verifyExport({ ...envelope, format_version: "tampered" })).toThrow();
    const cleared = await request.post(`${path}/clear`, { data: { revision: current.revision } });
    expect(await cleared.json()).toMatchObject({ enabled: true, content: "" });
  } finally {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
  }
});
