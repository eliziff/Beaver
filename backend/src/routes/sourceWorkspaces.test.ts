import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import { sha256 } from "../lib/hash";
import { createA2AJPassageEvidence } from "../lib/chat/legalEvidence";
import { createResearchFileState, researchFileMarkdown } from "../lib/researchFile";
import { verifyResearchPassage } from "../lib/researchFileQuery";
import { createSourceWorkspaceApplication } from "../lib/sourceWorkspaceApplication";
import { createSourceWorkspacesRouter } from "./sourceWorkspaces";

vi.mock("../lib/researchFileQuery", async (original) => { const module =
  await original<typeof import("../lib/researchFileQuery")>();
return { ...module, verifyResearchPassage: vi.fn(module.verifyResearchPassage) }; });

const version = { id: "v1", version_number: 1, working_revision: 0, created_by: "owner", source: "upload",
  created_at: "2026-01-01T00:00:00Z", filename: "Cases.research.md", file_type: "md",
  source_sha256: sha256(Buffer.from("document")) };
const sourceId = "10000000-0000-4000-8000-000000000001";

function fixture() {
  const documents = {
    metadata: vi.fn().mockResolvedValue(null),
    read: vi.fn().mockResolvedValue(null),
    readParts: vi.fn().mockResolvedValue([]),
    replaceVersion: vi.fn().mockResolvedValue({ status: "replaced", version: { ...version, working_revision: 1 } }),
  } as unknown as DocumentStore;
  const app = express();
  app.use(express.json());
  app.use("/source-workspaces", createSourceWorkspacesRouter(createSourceWorkspaceApplication(documents, {
    chats: {} as never, tables: {} as never,
    tabular: async () => { throw new Error("No tables in this fixture"); } })));
  return { app, documents };
}
function saved(documents: DocumentStore, state = createResearchFileState(), revision = 0) {
  const bytes = Buffer.from(researchFileMarkdown("Cases", state));
  vi.mocked(documents.metadata).mockResolvedValue({ id: "d1", filename: "Cases.research.md",
    current_version_id: "v1", current_working_revision: revision } as never);
  vi.mocked(documents.read).mockResolvedValue({ bytes, filename: "Cases.research.md", fileType: "md",
    hasPdfRendition: false, version: { ...version, working_revision: revision, size_bytes: bytes.length,
      source_sha256: sha256(bytes) } } as never);
  return bytes;
}

describe("Sources workspace routes", () => {
  beforeEach(() => process.env.AUTH_MODE = "local");

  it("commits one snapshot and returns passage IDs without a rescan", async () => {
    const { app, documents } = fixture(), state = createResearchFileState(), receipt = createA2AJPassageEvidence({
      citation: "Example", name: "Example", dataset: "scc", language: "en",
      sourceText: "holding", spanText: "holding", start: 0, end: 7, externalUrl: null,
      sourceClass: "case", sourceReference: { id: "case-1" } });
    state.sources[sourceId] = { id: sourceId, reference: { provider: "a2aj", id: "case-1",
      kind: "case" }, labelIds: [],
      note: "", passages: null };
    saved(documents, state);
    vi.mocked(verifyResearchPassage).mockResolvedValueOnce({ type: "merge", evidence: [receipt], labels: { [receipt.evidence_id]: [] } });
    const response = await request(app).post("/source-workspaces/d1/actions").send({
      version_id: "v1", working_revision: 0, action: { type: "passage", sourceId,
        locator: { kind: "paragraph", value: "1" }, quote: "holding" } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sourceId, evidenceId: receipt.evidence_id });
    expect(documents.replaceVersion).toHaveBeenCalledWith(
      expect.anything(), "d1", "v1", 0, expect.objectContaining({ fileType: "md" }));
  });

  it("marks stale workspace revisions as retryable and missing workspaces as absent", async () => {
    const { app, documents } = fixture();
    expect((await request(app).post("/source-workspaces/d1/actions").send({
      version_id: "v1", working_revision: 0, action: { type: "note", markdown: "Reviewed" } })).status).toBe(404);
    saved(documents, createResearchFileState(), 1);
    const action = await request(app).post("/source-workspaces/d1/actions").send({
      version_id: "v1", working_revision: 0, action: { type: "note", markdown: "Reviewed" } });
    const query = await request(app).post("/source-workspaces/d1/query").send({
      version_id: "v1", working_revision: 0, text: "fairness", syntax: "literal", target: "sources" });
    expect([action.status, query.status]).toEqual([409, 409]);
    expect([action.body, query.body]).toEqual([
      expect.objectContaining({ code: "revision_conflict" }),
      expect.objectContaining({ code: "revision_conflict" }),
    ]);
  });

  it("supports an unlabeled-source filter without inventing a pseudo-label", async () => {
    const { app, documents } = fixture();
    saved(documents);
    const response = await request(app).post("/source-workspaces/d1/query").send({
      version_id: "v1", working_revision: 0, text: "fairness", syntax: "literal",
      target: "sources", unlabelled: true });
    expect(response.status).toBe(200);
    expect(response.body.coverage).toMatchObject({ complete: true, next_after: null,
      attempted_sources: 0, selected_sources: 0 });
    const written = vi.mocked(documents.replaceVersion).mock.calls[0][4], queryPart =
      written.parts?.put?.find(({ name }) => name === "queries.json");
    const stored = JSON.parse(queryPart!.bytes.toString()).queries[response.body.receipt.query_id];
    expect(response.body.receipt).toEqual(stored);
    expect(stored.input).toMatchObject({ unlabelled: true });
  });

  it("keeps item cursors across metadata edits but rejects changed passage content", async () => {
    const { app, documents } = fixture(), receipts = Array.from({ length: 3 }, (_, index) => createA2AJPassageEvidence({
      citation: "Example", name: "Example", dataset: "scc", language: "en",
      sourceText: `holding ${index}`, spanText: `holding ${index}`, start: 0, end: 9,
      externalUrl: null, sourceClass: "case", sourceReference: { id: "case-1" } })),
      evidence = Object.fromEntries(receipts.map((receipt) => [receipt.evidence_id,
        { receipt, sourceId, labelIds: [], note: "" }])), part = Buffer.from(JSON.stringify({
          schemaVersion: "beaver.research-source.v1", sourceId, evidence })),
      state = createResearchFileState();
    state.sources[sourceId] = { id: sourceId, reference: { provider: "a2aj", id: "case-1",
      kind: "case", citation: "Example" }, labelIds: [],
      note: "",
      passages: { count: 3, sha256: sha256(part), labelCounts: {}, unlabelledCount: 3 } };
    saved(documents, state);
    vi.mocked(documents.readParts).mockImplementation(async (_scope, _id, _version, names) =>
      names.includes(`source.${sourceId}.json`)
        ? [{ name: `source.${sourceId}.json`, bytes: part, sha256: sha256(part) }] : []);

    const items = (query: Record<string, unknown>) => request(app).get("/source-workspaces/d1/items").query(query);
    expect((await items({ kind: "passages", source_id: sourceId })).body.total).toBe(0);
    const first = await items({ kind: "evidence", source_id: sourceId, limit: 2 });
    expect(first.body).toMatchObject({ total: 3, items: [{ index: 0 }, { index: 1 }] });
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await items({ kind: "evidence", source_id: sourceId, limit: 2, cursor: first.body.next_cursor });
    expect(second.body).toMatchObject({ total: 3, items: [{ index: 2 }], next_cursor: null });
    expect((await items({ kind: "passages", source_id: "20000000-0000-4000-8000-000000000002" })).status).toBe(404);
    state.sources[sourceId]!.note = "Updated source note";
    saved(documents, state, 1);
    const continued = await items({ kind: "evidence", source_id: sourceId, limit: 2, cursor: first.body.next_cursor });
    expect(continued.status).toBe(200);
    expect(continued.body).toMatchObject({ items: [{ index: 2 }], next_cursor: null });
    state.sources[sourceId]!.passages!.sha256 = sha256("changed");
    saved(documents, state, 1);
    expect((await items({ kind: "evidence", source_id: sourceId, limit: 2, cursor: first.body.next_cursor })).status).toBe(400);
  });

  it("does not offer an implicit Library ontology or global membership endpoint", async () => {
    const { app, documents } = fixture();
    expect((await request(app).post("/source-workspaces/ontology").send({})).status).toBe(404);
    expect((await request(app).get("/source-workspaces/ontology")).status).toBe(404);
    expect((await request(app).get("/source-workspaces/membership?document_ids=doc-1")).status).toBe(404);
    expect(documents.replaceVersion).not.toHaveBeenCalled();
  });

});
