import { expect, it } from "vitest";
import type { DocumentStore } from "../documentStore";
import { createA2AJPassageEvidence } from "../chat/legalEvidence";
import { createResearchFileState, researchReferenceFromEvidence, researchSourceResource,
  type ResearchEvidence, type ResearchFile } from "../researchFile";
import type { ResearchSubject } from "../researchSelection";
import { sha256 } from "../hash";
import { resolveResearchArrangement } from "./researchArrangement";
import { researchTableArrangement } from "./researchImport";

const sourceId = "11111111-1111-4111-8111-111111111111",
  topic = "22222222-2222-4222-8222-222222222222",
  notice = "33333333-3333-4333-8333-333333333333",
  payment = "44444444-4444-4444-8444-444444444444";

function fixture() {
  const text = "Notice may be sent by email. Payment must arrive by Friday.",
    receipts = ["Notice may be sent by email.", "Payment must arrive by Friday."].map((spanText) =>
      createA2AJPassageEvidence({ citation: "Input 1", name: "Agreement", dataset: "test", language: "en",
        sourceText: text, spanText, start: text.indexOf(spanText), end: text.indexOf(spanText) + spanText.length,
        externalUrl: null, sourceClass: "case", sourceReference: { id: "input-1" } })),
    state = createResearchFileState(), reference = researchReferenceFromEvidence(receipts[0])!,
    evidence: Record<string, ResearchEvidence> = Object.fromEntries(receipts.map((receipt, index) =>
      [receipt.evidence_id, { receipt, sourceId, labelIds: [index ? payment : notice],
        note: index ? "" : "Confirm the address" }])),
    bytes = Buffer.from(JSON.stringify({ schemaVersion: "beaver.research-source.v1", sourceId, evidence }));
  state.labels = Object.fromEntries([[topic, "Contract", null, "source"], [notice, "Notice", null, "highlight"],
    [payment, "Payment", null, "highlight"]].map(([id, name, parentId, scope]) => [id,
      { id, name, parentId, order: 0, color: null, scope }])) as typeof state.labels;
  state.sources[sourceId] = { id: sourceId, reference, labelIds: [topic], badge: "", note: "Master agreement",
    passages: { count: 2, sha256: sha256(bytes), labelCounts: { [notice]: 1, [payment]: 1 }, unlabelledCount: 0 } };
  const file = { document: { id: "workspace" }, state, versionId: "v1", workingRevision: 0 } as ResearchFile,
    documents = { readParts: async () => [{ name: `source.${sourceId}.json`, bytes, sha256: sha256(bytes) }] } as unknown as DocumentStore,
    subjects: ResearchSubject[] = [{ sourceId, resource: researchSourceResource(reference), reference }],
    parts = new Map([[sourceId, evidence]]);
  return { file, documents, subjects, parts, receipts };
}

const mapped = (result: ReturnType<typeof researchTableArrangement>) =>
  new Set(result.arrangement.cells.map(({ rowId, columnIndex }) => `${rowId}:${columnIndex}`));

it("imports one row per source with its labels, note and pen columns, and maps every cell", async () => {
  const f = fixture(), result = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources" });
  expect(result.columns_config.map(({ name }) => name)).toEqual(["Labels", "Note", "Notice", "Payment"]);
  expect(result.columns_config.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
  expect(result.arrangement.rows).toEqual([{ id: sourceId, title: "Agreement", sourceId, group: [topic] }]);
  expect(mapped(result).size).toBe(4);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: result.columns_config, arrangement: result.arrangement, storedCells: [], strict: true });
  expect(resolved.cells.map(({ status }) => status)).toEqual(["done", "done", "done", "done"]);
  expect(resolved.cells.map(({ content }) => content?.summary)).toEqual(["Contract", "Master agreement",
    f.receipts[0].span_text, f.receipts[1].span_text]);
});

it("imports one row per passage, adds a Passage column and narrows rows to the chosen pen", async () => {
  const f = fixture(), all = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages" });
  expect(all.columns_config.map(({ name }) => name)).toEqual(["Labels", "Note", "Passage", "Notice", "Payment"]);
  expect(all.arrangement.rows.map(({ id, title }) => ({ id, title }))).toEqual(f.receipts.map((receipt) =>
    ({ id: `${sourceId}:${receipt.evidence_id}`, title: `Agreement · ${receipt.span_text}` })));
  expect(mapped(all).size).toBe(10);
  const penned = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages", labelId: notice });
  expect(penned.arrangement.rows.map(({ id }) => id)).toEqual([`${sourceId}:${f.receipts[0].evidence_id}`]);
  expect(penned.columns_config.map(({ name }) => name)).toEqual(["Labels", "Note", "Passage", "Notice"]);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: penned.columns_config, arrangement: penned.arrangement, storedCells: [], strict: true });
  expect(resolved.cells.map(({ content }) => content?.summary))
    .toEqual(["Contract", "Confirm the address", f.receipts[0].span_text, f.receipts[0].span_text]);
});

it("caps an oversized workspace at the arrangement row limit", () => {
  const f = fixture(), subjects = Array.from({ length: 500 }, (_, index) => {
    const id = `s${index}`;
    f.file.state.sources[id] = { id, reference: { provider: "a2aj", id: `case-${index}`, kind: "case",
      citation: `Case ${index}` }, labelIds: [], badge: "", note: "", passages: null };
    return { sourceId: id, resource: `source://a2aj/${index}`, reference: f.file.state.sources[id].reference };
  });
  const result = researchTableArrangement(f.file, subjects, new Map(), [], { rows: "sources" });
  expect(result.arrangement.rows).toHaveLength(400);
  expect(result.arrangement.cells).toHaveLength(400 * result.columns_config.length);
});
