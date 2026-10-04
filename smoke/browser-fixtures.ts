import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test as base, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
export { expect, type Page, type TestInfo } from "@playwright/test";
export const test = base.extend({
  context: async ({ context }, use, info) => {
    await context.addInitScript(submission => sessionStorage.setItem("beaver.promptSubmission", JSON.stringify(submission)),
      { origin: "machine_test", run_id: process.env.BEAVER_TEST_RUN_ID ?? `browser-${randomUUID()}`, scenario: info.title });
    await use(context);
  },
});
export async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const response = await request.fetch(url, { method, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${url}: ${await response.text()}`).toBe(true);
  return response.status() === 204 ? null : response.json();
}
export async function upload(request: APIRequestContext, filename: string, text: string) {
  const response = await request.post("/api/library/files/documents", { multipart: {
    file: { name: filename, mimeType: "text/plain", buffer: Buffer.from(text) },
  } });
  expect(response.status()).toBe(201);
  return response.json();
}
export async function deleteDocument(request: APIRequestContext, id: string) {
  const document = await api(request, "GET", `/api/single-documents/${id}`);
  await api(request, "DELETE", `/api/single-documents/${id}`, {
    expected_current_version_id: document.current_version_id,
    expected_working_revision: document.current_working_revision,
    expected_project_id: document.project_id, expected_folder_id: document.folder_id ?? null,
  });
}
export function files(action: string, directory: string, ...inputs: string[]) {
  return JSON.parse(execFileSync(process.env.PYTHON ?? "python", [path.join(__dirname, "work-product-files.py"),
    action, directory, ...inputs], { encoding: "utf8", timeout: 60000 }));
}
export async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(name), fullPage: true });
}

export async function cleanup(...removals: Promise<unknown>[]) {
  const results = await Promise.allSettled(removals);
  const failed = results.filter(result => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(result => (result as PromiseRejectedResult).reason), "Browser fixture cleanup failed");
}

// Register successful browser-created records immediately, even if the next UI wait fails.
export function ownedBrowserRecords(page: Page, request: APIRequestContext) {
  const documents = new Set<string>(), products = new Set<string>(), pending: Promise<void>[] = [];
  const observe = (response: import("@playwright/test").Response) => {
    if (!response.ok() || response.request().method() !== "POST") return;
    const url = new URL(response.url()).pathname;
    if (url !== "/api/work-products" && !["/api/library/files/documents", "/api/court-records/documents", "/api/single-documents"].includes(url)) return;
    pending.push(response.json().then(value => {
      const id = value.id ?? value.document?.id;
      if (id) (url === "/api/work-products" ? products : documents).add(id);
    }));
  };
  page.on("response", observe);
  return async () => {
    page.off("response", observe); const observed = await Promise.allSettled(pending);
    const productDeletes = await Promise.allSettled([...products].map(id => api(request, "DELETE", `/api/work-products/${id}`)));
    const documentDeletes = await Promise.allSettled([...documents].map(id => deleteDocument(request, id)));
    const failed = [...observed, ...productDeletes, ...documentDeletes].filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => (result as PromiseRejectedResult).reason), "Browser fixture cleanup failed");
  };
}
