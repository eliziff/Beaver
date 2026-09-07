import { expect, it } from "vitest";
import type { DocumentStore } from "../documentStore";
import { createA2AJPassageEvidence } from "../chat/legalEvidence";
import { createResearchFileState, researchReferenceFromEvidence, researchSourceResource,
  type ResearchEvidence, type ResearchFile } from "../researchFile";
import type { ResearchSubject } from "../researchSelection";
import { sha256 } from "../hash";
import { resolveResearchArrangement } from "./researchArrangement";
import { selectFindingClaims, type ResearchFinding } from "../researchChat";
import { researchFindingReferenceSchema, researchFindingWithin } from "../researchFindingReference";
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

it("prefills existing source classifications, excerpts and notes without model extraction", async () => {
  const f = fixture(), result = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources" });
  expect(result.columns_config.map(({ name }) => name)).toEqual(["Contract", "Notice", "Payment", "Notes"]);
  expect(result.columns_config.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
  expect(result.arrangement.rows).toEqual([{ id: sourceId, title: "Agreement", sourceId, group: [topic] }]);
  expect(mapped(result).size).toBe(4);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: result.columns_config, arrangement: result.arrangement, storedCells: [], strict: true });
  expect(resolved.cells.map(({ status }) => status)).toEqual(["done", "done", "done", "done"]);
  expect(resolved.cells.map(({ content }) => content?.summary)).toEqual(["Contract", f.receipts[0].span_text, f.receipts[1].span_text, "Master agreement"]);
});

it("uses each selected passage as a row and keeps missing notes unrun", async () => {
  const f = fixture(), all = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages" });
  expect(all.columns_config.map(({ name }) => name)).toEqual(["Passage", "Highlight type", "Contract", "Notes"]);
  expect(all.arrangement.rows.map(({ id, title }) => ({ id, title }))).toEqual(f.receipts.map((receipt) =>
    ({ id: `${sourceId}:${receipt.evidence_id}`, title: `Agreement · ${receipt.span_text}` })));
  expect(mapped(all).size).toBe(7);
  const penned = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages", labelId: notice });
  expect(penned.arrangement.rows.map(({ id }) => id)).toEqual([`${sourceId}:${f.receipts[0].evidence_id}`]);
  expect(penned.columns_config.map(({ name }) => name)).toEqual(["Passage", "Highlight type", "Contract", "Notes"]);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: penned.columns_config, arrangement: penned.arrangement, storedCells: [], strict: true });
  expect(resolved.cells.map(({ content }) => content?.summary))
    .toEqual([f.receipts[0].span_text, "Notice", "Contract", "Confirm the address"]);
});

it("rejects oversized selections instead of silently dropping rows", () => {
  const f = fixture(), subjects = Array.from({ length: 500 }, (_, index) => {
    const id = `s${index}`;
    f.file.state.sources[id] = { id, reference: { provider: "a2aj", id: `case-${index}`, kind: "case",
      citation: `Case ${index}` }, labelIds: [], badge: "", note: "", passages: null };
    return { sourceId: id, resource: `source://a2aj/${index}`, reference: f.file.state.sources[id].reference };
  });
  const result = researchTableArrangement(f.file, subjects, new Map(), [], { rows: "sources" });
  expect(result.arrangement.rows).toHaveLength(500);
  expect(result.arrangement.cells).toEqual([]);
  f.file.state.sources.overflow = { ...f.file.state.sources.s0, id: "overflow" };
  expect(() => researchTableArrangement(f.file, [...subjects, { ...subjects[0], sourceId: "overflow" }], new Map(), [], { rows: "sources" }))
    .toThrow("at most 500 sources");
});


it("does not seed highlight rows or highlight columns from background reads", () => {
  const f = fixture(), values = f.parts.get(sourceId)!;
  for (const item of Object.values(values)) item.labelIds = [];
  expect(researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages" }).arrangement.rows).toEqual([]);
  const sourceRows = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources" });
  expect(sourceRows.columns_config.map(({ name }) => name)).toEqual(["Contract", "Notes"]);
});


it("splits original grounded claims into requested columns without copying unrelated claims or inventing answers", async () => {
  const f = fixture(), reference = { kind: "answer" as const, chatId: "chat", answerId: "answer", resource: f.subjects[0].resource };
  const finding: ResearchFinding = { reference, kind: "answer", sourceId, resource: reference.resource,
    question: { id: "answer", title: "What obligations apply?", prompt: "What obligations apply?" },
    answer: { claims: f.receipts.map((receipt, index) => ({ text: index ? "Payment is due on Friday." : "Email notice is permitted.", evidence_ids: [receipt.evidence_id] })) },
    evidence: f.receipts, origin: { chatId: "chat", messageId: "message" } };
  const input = [{ title: "Research chat", findings: [finding] }];
  const initial = researchTableArrangement(f.file, f.subjects, f.parts, input, { rows: "sources" });
  expect(initial.fields.filter(({ kind }) => kind === "finding")).toHaveLength(1);
  expect(initial.columns_config.filter(({ name }) => name === "What obligations apply?")).toHaveLength(1);
  const fields = initial.fields.filter(({ kind }) => kind === "claim");
  const plan = researchTableArrangement(f.file, f.subjects, f.parts, input, { rows: "sources", columns: [
    { index: 0, name: "Notice", prompt: "How may notice be sent?", fieldIds: [fields[0].id] },
    { index: 1, name: "Payment", prompt: "When is payment due?", fieldIds: [fields[1].id] },
    { index: 2, name: "Remedy", prompt: "What is the remedy for late payment?", fieldIds: [] },
  ] });
  expect(plan.reuse.map(({ reused, unrun }) => [reused, unrun])).toEqual([[1, 0], [1, 0], [0, 1]]);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: plan.columns_config, arrangement: plan.arrangement, storedCells: [], strict: true,
    resolveFinding: async (ref) => selectFindingClaims(finding, ref) });
  expect(resolved.cells[0].content?.claims).toEqual([finding.answer.claims[0]]);
  expect(resolved.cells[0].content?.evidence).toEqual([f.receipts[0]]);
  expect(resolved.cells[1].content?.claims).toEqual([finding.answer.claims[1]]);
  expect(resolved.cells[1].content?.evidence).toEqual([f.receipts[1]]);
  expect(resolved.cells.some(({ column_index }) => column_index === 2)).toBe(false); // Repository creates the unrun cell.
  expect(() => selectFindingClaims(finding, { ...reference, claimIndices: [99] })).toThrow("outside this finding");
  expect(researchFindingReferenceSchema.safeParse({ ...reference, claimIndices: [0, 0] }).success).toBe(false);
  expect(researchFindingWithin({ ...reference, claimIndices: [0] }, reference)).toBe(true);
  expect(researchFindingWithin(reference, { ...reference, claimIndices: [0] })).toBe(false);
  expect(researchFindingWithin({ ...reference, claimIndices: [1] }, { ...reference, claimIndices: [0] })).toBe(false);
});

it("does not interpret a label or an excerpt as a boolean outcome", () => {
  const f = fixture();
  expect(() => researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources", columns: [
    { index: 0, name: "Valid contract?", prompt: "Is this a valid contract?", format: "yes_no", fieldIds: [`labels:${topic}`] },
  ] })).toThrow("typed result");
  expect(() => researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources", columns: [
    { index: 0, name: "Notice", prompt: "Notice?", fieldIds: ["unknown"] },
  ] })).toThrow("unavailable");
});

it("deduplicates repeated findings by question and respects exact passage scopes", () => {
  const f = fixture();
  const finding: ResearchFinding = { kind: "answer", reference: { kind: "answer", chatId: "a", answerId: "a", resource: f.subjects[0].resource },
    sourceId, resource: f.subjects[0].resource, question: { id: "a", title: "Notice", prompt: "How may notice be sent?" },
    answer: { claims: [{ text: "Email.", evidence_ids: [f.receipts[0].evidence_id] }] }, evidence: [f.receipts[0]], origin: {} };
  const same = { ...finding, reference: { ...finding.reference, chatId: "b" }, question: { ...finding.question, id: "b" } } as ResearchFinding;
  const plan = researchTableArrangement(f.file, [{ ...f.subjects[0], evidence: [f.receipts[0]] }], f.parts,
    [{ title: "First chat", findings: [finding] }, { title: "Follow-up", findings: [same] }], { rows: "sources" });
  const question = plan.columns.find(({ fieldIds }) => fieldIds[0]?.startsWith("question:"))!;
  expect(plan.arrangement.cells.find(({ columnIndex }) => columnIndex === question.index)?.items).toHaveLength(1);
  expect(plan.fields.some(({ id }) => id === `highlights:${payment}`)).toBe(false);
  expect(plan.arrangement.rows[0].evidenceIds).toEqual([f.receipts[0].evidence_id]);
});
