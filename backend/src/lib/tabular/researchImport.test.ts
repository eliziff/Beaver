import { expect, it } from "vitest";
import type { DocumentStore } from "../documentStore";
import { createA2AJPassageEvidence } from "../chat/legalEvidence";
import { createResearchFileState, researchReferenceFromEvidence, researchSourceResource,
  type ResearchEvidence, type ResearchFile } from "../researchFile";
import type { ResearchSubject } from "../researchSelection";
import { sha256 } from "../hash";
import { researchImportCatalog, defaultResearchImport, researchImportPlan } from "./researchImport";
import type { ResearchFinding } from "../researchChat";
const researchTableArrangement = (...[file, subjects, parts, chats, input]: [ResearchFile, ResearchSubject[], Map<string, Record<string, ResearchEvidence>>, Array<{ title: string; findings: ResearchFinding[] }>, { rows: "sources" | "passages"; labelId?: string }]) => {
  const catalog = researchImportCatalog(file, subjects, parts, chats.flatMap(({ findings }) => findings), input);
  return researchImportPlan(catalog, defaultResearchImport(catalog));
};

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
  state.sources[sourceId] = { id: sourceId, reference, labelIds: [topic],
      note: "Master agreement",
    passages: { count: 2, sha256: sha256(bytes), labelCounts: { [notice]: 1, [payment]: 1 }, unlabelledCount: 0 } };
  const file = { document: { id: "workspace" }, state, versionId: "v1", workingRevision: 0 } as ResearchFile,
    documents = { readParts: async () => [{ name: `source.${sourceId}.json`, bytes, sha256: sha256(bytes) }] } as unknown as DocumentStore,
    subjects: ResearchSubject[] = [{ sourceId, resource: researchSourceResource(reference), reference }],
    parts = new Map([[sourceId, evidence]]);
  return { file, documents, subjects, parts, receipts };
}

const mapped = (result: ReturnType<typeof researchTableArrangement>) =>
  new Set(result.arrangement.cells.map(({ rowId, columnIndex }) => `${rowId}:${columnIndex}`));

it("never silently drops rows when a conversion exceeds its bound", () => {
  const f = fixture(), subjects = Array.from({ length: 500 }, (_, index) => {
    const id = `s${index}`;
    f.file.state.sources[id] = { id, reference: { provider: "a2aj", id: `case-${index}`, kind: "case",
      citation: `Case ${index}` }, labelIds: [],
      note: "", passages: null };
    return { sourceId: id, resource: `source://a2aj/${index}`, reference: f.file.state.sources[id].reference };
  });
  const result = researchTableArrangement(f.file, subjects, new Map(), [], { rows: "sources" });
  expect(result.arrangement.rows).toHaveLength(500);
  expect(result.arrangement.cells).toHaveLength(0);
  const extra = { ...subjects[0], sourceId: "extra" };
  f.file.state.sources.extra = { ...f.file.state.sources.s0, id: "extra" };
  expect(() => researchTableArrangement(f.file, [...subjects, extra], new Map(), [], { rows: "sources" })).toThrow(/no rows were dropped/);
});

function finding(f: ReturnType<typeof fixture>, question: string, texts = ["Existing answer"], format = "text"): ResearchFinding {
  const resource = f.subjects[0].resource;
  return { reference: { kind: "answer", chatId: "chat", answerId: question, resource }, kind: "answer", sourceId, resource,
    question: { id: question, title: question, prompt: question, format },
    answer: { claims: texts.map((text, index) => ({ text, evidence_ids: [f.receipts[index % 2].evidence_id] })) },
    evidence: f.receipts, origin: { chatId: "chat", messageId: question } };
}
it("rejects fabricated items, cross-row mappings, overlapping claims and incompatible typed answers", () => {
  const f = fixture(), answer = finding(f, "Why?", ["One", "Two"]),
    catalog = researchImportCatalog(f.file, f.subjects, f.parts, [answer], { rows: "sources" }),
    entry = catalog.entries.find(({ kind }) => kind === "passages")!,
    design = { title: "Review", columns: [{ index: 1, name: "Question", prompt: "Question?" }],
      cells: [{ rowId: sourceId, columnIndex: 1, itemIds: [entry.id] }] };
  expect(() => researchImportPlan(catalog, { ...design, cells: [{ ...design.cells[0], itemIds: ["fabricated"] }] })).toThrow(/outside/);
  expect(() => researchImportPlan(catalog, { ...design, cells: [{ ...design.cells[0], rowId: "other" }] })).toThrow(/selected row/);
  expect(() => researchImportPlan(catalog, { ...design, columns: [{ ...design.columns[0], format: "yes_no" }] })).toThrow(/compatible/);
  const original = catalog.entries.filter(({ kind }) => kind === "answer");
  expect(() => researchImportPlan(catalog, { ...design, cells: [{ ...design.cells[0], itemIds: original.map(({ id }) => id) }] })).toThrow(/overlapping/);
});
