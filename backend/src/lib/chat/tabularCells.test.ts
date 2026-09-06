import { expect, it } from "vitest";
import { createLegalEvidenceCitations } from "./citations";
import { createLibraryEvidence, createLegalEvidenceTurnState,
  renderLegalEvidenceAnswer, submitLegalEvidenceAnswer } from "./legalEvidence";
import { readTabularCells, tabularTool } from "./tabularCells";
import type { TabularCellStore } from "./types";

it("reads the stored answer and grounds chat in its original source, with cell navigation", () => {
  const state = createLegalEvidenceTurnState();
  const receipt = createLibraryEvidence({ documentId: "doc-1", versionId: "v1",
    filename: "Lease.pdf", sourceText: "The initial term is five years.",
    spanText: "The initial term is five years.", start: 0, end: 31,
    locator: { kind: "page", label: "4" } });
  const answer = { summary: "5", value: 5, flag: "green" as const,
    reasoning: "The initial lease term is five years, before any renewal.",
    claims: [{ text: "The initial term is five years.", evidence_ids: [receipt.evidence_id] }],
    evidence: [receipt], outcome: "answered" as const, coverage: "complete" as const,
    resource: "document://doc-1/version/v1" };
  const result = readTabularCells({ review_id: "review-1",
    columns: [{ index: 7, name: "Term" }],
    documents: [{ id: "doc-1", filename: "Lease.pdf" }],
    cells: new Map([["7:doc-1", { content: answer, status: "done" }]]),
  }, state);

  const read = JSON.parse(result.content);
  const { evidence: _receipts, ...storedAnswer } = answer;
  expect(read.cells).toEqual([{ col_index: 0, row_index: 0, status: "done", ...storedAnswer }]);
  expect(read.evidence).toEqual([{ evidence_id: receipt.evidence_id,
    citation: receipt.citation, name: receipt.name, locator: receipt.locator,
    exact_passage: receipt.span_text }]);
  expect(read).toMatchObject({ review_id: "review-1",
    columns: [{ col_index: 0, col_name: "Term" }],
    rows: [{ row_index: 0, document_id: "doc-1", doc_name: "Lease.pdf" }] });
  expect(result.citations).toEqual([{ kind: "tabular", ref: 1, quotes: [], review_id: "review-1",
    col_index: 0, row_index: 0, col_name: "Term", doc_name: "Lease.pdf" }]);
  expect([...state.evidence.values()].map(({ receipt }) => receipt)).toEqual([receipt]);
  expect(submitLegalEvidenceAnswer({ claims: answer.claims }, state))
    .toEqual({ ok: true, terminal: true });
  expect(renderLegalEvidenceAnswer(state)).toBe("The initial term is five years. [1]");
  expect(createLegalEvidenceCitations(state)).toEqual([expect.objectContaining({
    kind: "document", document_id: "doc-1", version_id: "v1", locator: "4",
    quotes: [{ quote: "The initial term is five years." }],
  })]);
  const repeated = readTabularCells({ review_id: "review-1",
    columns: [{ index: 7, name: "Term" }, { index: 8, name: "Duration" }],
    documents: [{ id: "doc-1", filename: "Lease.pdf" }],
    cells: new Map([["7:doc-1", { content: answer, status: "done" }],
      ["8:doc-1", { content: answer, status: "done" }]]),
  }, createLegalEvidenceTurnState());
  const shared = JSON.parse(repeated.content);
  expect(shared.evidence).toEqual(read.evidence);
  expect(shared.columns).toEqual([{ col_index: 0, col_name: "Term" },
    { col_index: 1, col_name: "Duration" }]);
  expect(shared.cells).toEqual([0, 1].map((col_index) => ({
    col_index, row_index: 0, status: "done", ...storedAnswer })));
});

it("keeps a completed no-match distinct from pending, failed, and partially covered cells", () => {
  const state = createLegalEvidenceTurnState();
  const noMatch = { summary: "Not Found", claims: [], evidence: [],
    outcome: "not_found" as const, coverage: "complete" as const,
    resource: "document://doc-1/version/v1" };
  const store: TabularCellStore = { review_id: "review-1",
    columns: [{ index: 2, name: "Term" }],
    documents: ["complete", "pending", "error", "partial"].map((id) => ({ id, filename: id })),
    cells: new Map([
      ["2:complete", { content: noMatch, status: "done" }],
      ["2:pending", { content: null, status: "pending" }],
      ["2:error", { content: null, status: "error" }],
      ["2:partial", { content: { ...noMatch, coverage: "partial" }, status: "done" }],
    ]),
  };
  const result = readTabularCells(store, state).content;
  expect(result).toContain('"outcome":"not_found","coverage":"complete"');
  expect(result).toContain('"status":"pending"');
  expect(result).toContain('"status":"error"');
  expect(result).toContain('"coverage":"partial"');
  expect(state.evidence.size).toBe(0);
  const selected = readTabularCells(store, state, [0], [2]).content;
  expect(JSON.parse(selected)).toMatchObject({
    columns: [{ col_index: 0, col_name: "Term" }],
    rows: [{ row_index: 2, document_id: "error", doc_name: "error" }],
    cells: [{ col_index: 0, row_index: 2, status: "error" }] });
});

it("can cite an original passage read with a cell even when the cell did not cite it", () => {
  const state = createLegalEvidenceTurnState(), text = "A renewal requires written notice.",
    receipt = createLibraryEvidence({ documentId: "doc-1", versionId: "v1",
      filename: "Lease.pdf", sourceText: text, spanText: text, start: 0, end: text.length,
      locator: { kind: "page", label: "5" } });
  readTabularCells({ review_id: "review-1", columns: [{ index: 0, name: "Term" }],
    documents: [{ id: "doc-1", filename: "Lease.pdf" }],
    cells: new Map([["0:doc-1", { status: "done", content: {
      summary: "Not found", claims: [], evidence: [receipt], outcome: "not_found",
      coverage: "partial", resource: "document://doc-1/version/v1",
    } }]]),
  }, state);
  expect(submitLegalEvidenceAnswer({ claims: [{ text, evidence_ids: [receipt.evidence_id] }] }, state))
    .toEqual({ ok: true, terminal: true });
  expect(createLegalEvidenceCitations(state)).toEqual([expect.objectContaining({
    document_id: "doc-1", version_id: "v1", locator: "5", quotes: [{ quote: text }],
  })]);
});

it("reads an authorized workspace table and rejects unrelated review IDs", async () => {
  const state = createLegalEvidenceTurnState(), store: TabularCellStore = {
    review_id: "linked", columns: [{ index: 0, name: "Term" }],
    documents: [{ id: "doc-1", filename: "Lease.pdf" }], cells: new Map(),
  }, tool = tabularTool(undefined, state, async (id) => id === "linked" ? store : null),
    signal = new AbortController().signal,
    linked = await tool.execute({ review_id: "linked" }, {}, signal,
      { id: "read-linked", name: "read_table_cells", input: { review_id: "linked" } });
  expect(linked.activityCitations).toEqual([expect.objectContaining({ review_id: "linked", row_index: 0 })]);
  expect((await tool.execute({ review_id: "unrelated" }, {}, signal,
    { id: "read-unrelated", name: "read_table_cells", input: { review_id: "unrelated" } })).result.isError).toBe(true);
});
