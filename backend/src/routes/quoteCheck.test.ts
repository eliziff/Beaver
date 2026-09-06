import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { createQuoteCheckRouter } from "./quoteCheck";
import type { DocumentStore } from "../lib/documentStore";
import { createAuthoritiesDraft } from "../lib/authoritiesDomain";

const checks = vi.hoisted(() => ({ fail: false }));
vi.mock("../lib/authoritiesImport", () => ({ createAuthoritiesImporter: () => ({
  draft: async () => createAuthoritiesDraft({ kind: "manual" }),
}) }));
vi.mock("../lib/quoteCheck", () => ({ checkQuotes: async (_draft: unknown, _links: unknown, _signal: unknown,
  progress: (done: number, total: number, quote: unknown) => void) => {
  const quote = { id: "q", unitId: "u", start: 0, end: 4, quote: "words", context: "words",
    pageNumbers: [], candidates: [], occurrenceId: null, linkMethod: "mechanical",
    status: "unresolved", detail: "No source", receipt: null };
  progress(1, checks.fail ? 2 : 1, quote);
  if (checks.fail) throw new Error("Interrupted source retrieval");
  return { mode: "mechanical", quotes: [quote], total: 1, citationUnits: [], counts: { unresolved: 1 } };
} }));
const mode = process.env.AUTH_MODE;
afterEach(() => { process.env.AUTH_MODE = mode; checks.fail = false; });

it("saves complete and interrupted checks beside the authenticated input, with the checked version", async () => {
  process.env.AUTH_MODE = "local";
  const saved: Array<{ bytes: Buffer; projectId: string; folderId: string; parts: Array<{ bytes: Buffer }> }> = [];
  const documents = { projectionSource: async () => ({ versionId: "v1", sourceSha256: "abc" }),
    metadata: async () => ({ id: "source", filename: "Draft.docx", project_id: "project", folder_id: "folder" }),
    create: async (scope: { userId: string }, value: typeof saved[number]) => {
      expect(scope.userId).toBeTruthy(); saved.push(value);
      return { id: `report-${saved.length}`, current_version_id: "report-version", filename: "Quote check.xlsx" };
    } } as unknown as DocumentStore;
  const app = express(); app.use(express.json()); app.use("/quote-check", createQuoteCheckRouter(documents));
  const response = await request(app).post("/quote-check").send({ documentId: "source", versionId: "v1" });
  expect(response.text).toContain('"done":true');
  checks.fail = true;
  const interrupted = await request(app).post("/quote-check").send({ documentId: "source", versionId: "v1" });
  expect(interrupted.text).toContain('"workbook":{"id":"report-2"');
  expect(saved).toHaveLength(2);
  for (const item of saved) {
    expect(item).toMatchObject({ projectId: "project", folderId: "folder" });
    expect(JSON.parse(item.parts[0].bytes.toString())).toMatchObject({ inputVersionId: "v1" });
  }
  const complete = XLSX.read(saved[0].bytes, { type: "buffer" });
  expect(XLSX.utils.sheet_to_json(complete.Sheets.Summary, { header: 1 })).toContainEqual(["Mode", "Mechanical quotation check"]);
  const partial = XLSX.read(saved[1].bytes, { type: "buffer" });
  expect(partial.Sheets["Quote check"].E1.v).toContain("incomplete");
  expect(XLSX.utils.sheet_to_json(partial.Sheets.Summary, { header: 1 })).toContainEqual(["Mode", "Mechanical quotation check — incomplete"]);
  expect((await request(app).post("/quote-check").send({})).status).toBe(400);
});
