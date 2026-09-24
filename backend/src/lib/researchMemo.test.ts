import { expect, it } from "vitest";
import { researchFindingsMarkdown } from "./researchMemo";
import { createLibraryEvidence } from "./chat/legalEvidence";
import { createResearchFileState, researchReferenceFromEvidence, type ResearchFile } from "./researchFile";
import type { ResearchFinding } from "./researchChat";

function fixture() {
  const receipts = ["a", "b"].map(documentId => createLibraryEvidence({ documentId, versionId: "v1", filename: `${documentId}.txt`,
    sourceText: "A qualified rule applies.", spanText: "A qualified rule applies.", start: 0, end: 25 })),
    state = createResearchFileState();
  receipts.forEach((receipt, index) => { state.sources[String(index)] = { id: String(index), collected: true,
    reference: researchReferenceFromEvidence(receipt)!, labelIds: [], note: "", passages: null }; });
  const file = { document: { id: "workspace" }, versionId: "v1", workingRevision: 0, state } as ResearchFile;
  const finding = (resource: string, index: number): ResearchFinding => ({
    reference: { kind: "answer", chatId: "chat", answerId: "answer", resource, claimIndices: [0] },
    kind: "answer", sourceId: String(index), resource, question: { id: "question", title: "Rule", prompt: "Which rule?" },
    answer: { claims: [{ text: "A qualified rule applies.", evidence_ids: receipts.map(receipt => receipt.evidence_id) }] },
    evidence: receipts, origin: { chatId: "chat" } });
  return { file, receipts, findings: [finding("document://a/version/v1", 0), finding("document://b/version/v1", 1)] };
}

it("copies a joint claim once with all its exact source links and leaves equal words with different support distinct", () => {
  const { file, receipts, findings } = fixture(), before = structuredClone(findings);
  const markdown = researchFindingsMarkdown(file, findings);
  expect(markdown.split("A qualified rule applies.")).toHaveLength(2);
  for (const receipt of receipts) expect(markdown).toContain(`evidence_id=${receipt.evidence_id}`);
  expect(findings).toEqual(before);
  findings[1].answer = { claims: [{ ...findings[1].answer.claims[0], evidence_ids: [receipts[1].evidence_id] }] };
  expect(researchFindingsMarkdown(file, findings).split("A qualified rule applies.")).toHaveLength(3);
});

it("retains explicit negative and zero-valued results without inventing passage evidence", () => {
  const { file, findings } = fixture(), finding = findings[0];
  finding.answer = { claims: [], outcome: "not_found", coverage: "partial" }; finding.evidence = [];
  const markdown = researchFindingsMarkdown(file, [finding]);
  expect(markdown).toContain("Not found in the reviewed material.");
  expect(markdown).toContain("Partial review."); expect(markdown).not.toContain("evidence_id=");
  for (const value of [false, 0]) {
    finding.answer = { claims: [], value, outcome: "answered", coverage: "complete" };
    expect(researchFindingsMarkdown(file, [finding])).toContain(`Rule: ${value}`);
  }
});

it("does not downgrade a missing supporting passage to a source-level citation", () => {
  const { file, findings } = fixture(); findings[0].evidence = [];
  expect(() => researchFindingsMarkdown(file, findings)).toThrow("supporting passage is unavailable");
});


it("keeps cited table rows in one Markdown table", () => {
  const { file, receipts, findings } = fixture();
  findings[0].answer.claims = [
    { text: "| Issue | Result |\n| --- | --- |\n| First | Qualified rule |", evidence_ids: [receipts[0].evidence_id] },
    { text: "| Second | Another rule |", evidence_ids: [receipts[1].evidence_id] },
  ];
  const markdown = researchFindingsMarkdown(file, [findings[0]]), rows = markdown.split("\n");
  expect(rows).toHaveLength(4);
  expect(rows.every(row => row.startsWith("|") && row.endsWith("|"))).toBe(true);
  expect(rows[2]).toContain(`evidence_id=${receipts[0].evidence_id}`);
  expect(rows[3]).toContain(`evidence_id=${receipts[1].evidence_id}`);
});
