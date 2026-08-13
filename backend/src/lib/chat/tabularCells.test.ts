import { expect, it } from "vitest";
import { createLegalEvidenceCitations } from "./citations";
import {
  createLegalEvidenceTurnState,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
} from "./legalEvidence";
import { readTabularCells } from "./tabularCells";

it("grounds a tabular answer in the cell that was read", () => {
  const state = createLegalEvidenceTurnState();
  const result = readTabularCells({
    review_id: "review-1",
    columns: [{ index: 7, name: "Term" }],
    documents: [{ id: "doc-1", filename: "Lease.pdf" }],
    cells: new Map([["7:doc-1", { summary: "The initial term is five years." }]]),
  }, state);
  const evidenceId = result.content.match(/Evidence: (e_\S+)/u)?.[1];

  expect(submitLegalEvidenceAnswer({
    claims: [{ text: "The initial term is five years.", evidence_ids: [evidenceId] }],
  }, state)).toEqual({ ok: true, terminal: true });
  expect(renderLegalEvidenceAnswer(state)).toBe("The initial term is five years. [1]");
  expect(createLegalEvidenceCitations(state)).toEqual([expect.objectContaining({
    kind: "tabular",
    review_id: "review-1",
    col_index: 0,
    row_index: 0,
  })]);
});
