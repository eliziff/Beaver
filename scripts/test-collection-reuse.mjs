// Production UI regression: fixture data only; no external services or credentials.
// node scripts/test-collection-reuse.mjs CANDIDATE_DIST [BASELINE_DIST] [REPORT_DIR]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "@playwright/test";
const [candidate, baseline, output = ".perf/collections"] = process.argv.slice(2);
if (!candidate) throw new Error("Provide a production build directory");
await mkdir(output, { recursive: true });
const user = { id: '00000000-0000-0000-0000-000000000001', email: 'local@localhost', pendingEmail: null, createdWithGoogle: false };
const project = { id: 'performance-fixture', user_id: user.id, name: 'Performance fixture', created_at: '2026-01-01T00:00:00Z', cm_number: null, practice: null };
const profile = {
  displayName: 'Fixture', organisation: null, practiceSetting: null, professionalTitle: null,
  practiceAreas: [], jurisdictionPreference: { mode: 'ask', jurisdictions: [] },
  onboardingCompleted: true, titleModel: '', tabularModel: '', lastSelectedChatModel: null,
  lastSelectedReasoningEffort: null, mfaOnLogin: false, legalResearchUs: false,
  features: { authorities: true }, workflowFileTargets: { 'court-records': null, authorities: null },
  filingContact: { name: '', address: '', phone: '', fax: '', email: '' },
  draftingStyle: { version: 1, memoHeader: { to: '', from: '' }, documents: Object.fromEntries(
    ['memo', 'factum', 'letter', 'other'].map(key => [key, { citationPlacement: 'footnotes', citationHyperlinks: true, numberHeadings: 'auto' }])) },
  apiKeyStatus: { sources: {} },
};

const second = { ...project, id: "second", name: "Second matter" };
const file = { id: "file-one", filename: "Authority.pdf", file_type: "pdf", project_id: null,
  folder_id: null, library_kind: "file", pdf_storage_path: null, size_bytes: 1024,
  page_count: 1, created_at: "2026-01-01T00:00:00Z" };
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
async function serve(directory) {
  const root = resolve(directory), requests = [];
  let gate = null, release = () => {}, changed = false, deleted = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost"), path = decodeURIComponent(url.pathname);
      requests.push({ path, method: req.method });
      const json = body => res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
      if (req.method === "DELETE" && path === `/api/projects/${project.id}`) { deleted = true; return json({}); }
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      if (path.startsWith("/api/")) {
        if (path === "/api/projects") {
          if (gate) await gate;
          return json(url.searchParams.get("scope") === "mine" ? { items: [], next_cursor: null }
            : url.searchParams.has("cursor") ? { items: [second], next_cursor: null }
            : { items: deleted ? [second] : [{ ...project, name: changed ? "Updated matter" : project.name }], next_cursor: deleted ? null : "second" });
        }
        if (path === "/api/library/files") return json({ items: [{ kind: "document", document: file }], next_cursor: null });
        if (path === "/api/user/profile") return json(profile);
        if (path === "/api/chat") return json([]);
        if (path === "/api/models") return json({ models: [] });
        if (path === "/api/auth/session") return json({ user });
        if (path === "/api/config") return json({ mode: "local", capabilities: { connectors: false } });
        return json({ items: [], next_cursor: null });
      }
      const asset = extname(path) ? path : "/index.html";
      const filename = resolve(root, `.${asset}`);
      if (!filename.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      let body = await readFile(filename);
      if (asset.endsWith(".html")) body = Buffer.from(body.toString().replace("__BEAVER_RUNTIME_CONFIG__",
        encodeURIComponent(JSON.stringify({ mode: "local", capabilities: { connectors: false } }))));
      res.writeHead(200, { "Content-Type": mime[extname(asset)] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { requests, origin: `http://127.0.0.1:${server.address().port}`,
    hold() { gate = new Promise(done => { release = done; }); },
    change() { changed = true; },
    release() { gate = null; release(); },
    async close() { gate = null; release(); await new Promise(done => server.close(done)); },
  };
}
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
const report = { method: "Production Chromium, fixture APIs, fresh browser per build. Revisit assertions hold the network response indefinitely; not a live-backend benchmark.", scenarios: [] };
async function scenario(directory, label, reuse) {
  const server = await serve(directory), context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  try {
    await page.goto(`${server.origin}/projects`);
    await page.getByRole("link", { name: project.name, exact: true }).waitFor();
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await page.getByRole("link", { name: second.name, exact: true }).waitFor();
    const initialChatReads = server.requests.filter(r => r.path === "/api/chat").length;
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await page.getByText(file.filename, { exact: true }).first().waitFor();
    // Return to Projects while its revalidation is deliberately prevented from finishing.
    server.hold();
    const start = Date.now();
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    const retainedFirst = await page.getByRole("link", { name: project.name, exact: true }).isVisible();
    const retainedSecond = await page.getByRole("link", { name: second.name, exact: true }).isVisible();
    assert.equal(retainedFirst, reuse); assert.equal(retainedSecond, reuse);
    const rowsAvailableWhileNetworkHeldMs = reuse ? Date.now() - start : null;
    await page.screenshot({ path: `${output}/${label}-return-network-held.png` });
    if (reuse) server.change();
    server.release();
    await page.getByRole("link", { name: reuse ? "Updated matter" : project.name, exact: true }).waitFor();
    if (reuse) await page.getByRole("link", { name: second.name, exact: true }).waitFor();
    const afterChatReads = server.requests.filter(r => r.path === "/api/chat").length;
    if (reuse) assert.equal(afterChatReads, initialChatReads, "navigation must not reload unrelated history");
    if (reuse) {
      // Previously empty filters also reuse their settled state, not a skeleton.
      await page.getByRole("tab", { name: "Mine", exact: true }).click();
      await page.getByText("No projects", { exact: true }).waitFor();
      await page.getByRole("tab", { name: "All", exact: true }).click();
      await page.getByRole("link", { name: "Updated matter", exact: true }).waitFor();
      server.hold();
      await page.getByRole("tab", { name: "Mine", exact: true }).click();
      assert.equal(await page.getByText("No projects", { exact: true }).isVisible(), true);
      server.release();
      await page.getByRole("tab", { name: "All", exact: true }).click();
      const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Updated matter", exact: true }) });
      await row.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("link", { name: "Updated matter", exact: true }).waitFor({ state: "detached" });
      await page.getByRole("link", { name: "Library", exact: true }).click();
      await page.getByText(file.filename, { exact: true }).first().waitFor();
      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await page.getByRole("link", { name: second.name, exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "Updated matter", exact: true }).count(), 0);
      await page.screenshot({ path: `${output}/${label}-after-delete-and-return.png` });
    }
    assert.deepEqual(errors, []);
    report.scenarios.push({ label, retainedFirst, retainedSecond, rowsAvailableWhileNetworkHeldMs,
      initialChatReads, afterChatReads, requests: server.requests, browserErrors: errors });
  } finally { server.release(); await context.close(); await server.close(); }
}
try {
  if (baseline) await scenario(baseline, "baseline", false);
  await scenario(candidate, "candidate", true);
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
