import { expect, it } from "vitest";
import type { DocumentStore } from "../documentStore";
import { createA2AJPassageEvidence } from "../chat/legalEvidence";
import { createResearchFileState, researchReferenceFromEvidence, researchSourceResource,
  type ResearchFile } from "../researchFile";
import { sha256 } from "../hash";
import { resolveResearchArrangement, type ResearchArrangement } from "./researchArrangement";

const sourceId = "11111111-1111-4111-8111-111111111111",
  root = "22222222-2222-4222-8222-222222222222",
  first = "33333333-3333-4333-8333-333333333333",
  second = "44444444-4444-4444-8444-444444444444";
function fixture() {
  const text = "Notice may be sent by email. Payment must arrive by Friday.",
    receipts = ["Notice may be sent by email.", "Payment must arrive by Friday."].map((spanText) =>
      createA2AJPassageEvidence({ citation: "Input 1", name: "Agreement", dataset: "test", language: "en",
        sourceText: text, spanText, start: text.indexOf(spanText), end: text.indexOf(spanText) + spanText.length,
        externalUrl: null, sourceClass: "case", sourceReference: { id: "input-1" } })),
    state = createResearchFileState(), reference = researchReferenceFromEvidence(receipts[0])!,
    evidence = Object.fromEntries(receipts.map((receipt, index) => [receipt.evidence_id,
      { receipt, sourceId, labelIds: [index ? second : first], note: "" }])),
    bytes = Buffer.from(JSON.stringify({ schemaVersion: "beaver.research-source.v1", sourceId, evidence }));
  state.labels = Object.fromEntries([[root, "Obligations", null], [first, "Notice", root],
    [second, "Payment", root]].map(([id, name, parentId]) => [id, { id, name, parentId,
      order: 0, color: null, scope: "highlight" }])) as typeof state.labels;
  state.sources[sourceId] = { id: sourceId, reference, labelIds: [],
      note: "",
    passages: { count: 2, sha256: sha256(bytes), labelCounts: { [first]: 1, [second]: 1 }, unlabelledCount: 0 } };
  state.chats = ["chat-1"];
  const file = { document: { id: "workspace" }, state, versionId: "v1", workingRevision: 0 } as ResearchFile,
    documents = { readParts: async () => [{ name: `source.${sourceId}.json`, bytes, sha256: sha256(bytes) }] } as unknown as DocumentStore,
    arrangement: ResearchArrangement = { rows: receipts.map((receipt, index) => ({ id: `branch-${index}`,
      title: `Branch ${index + 1}`, sourceId, evidenceIds: [receipt.evidence_id], group: [root] })),
      cells: receipts.map((receipt, index) => ({ rowId: `branch-${index}`, columnIndex: 4, items: [{
        kind: "label", labelId: index ? second : first, sourceId, evidenceId: receipt.evidence_id, display: "path",
      }] })) },
    input = { documents, scope: { userId: "user-1" }, file, arrangement,
      columns: [{ index: 4, name: "Topic", prompt: "" }], storedCells: [] };
  return { ...input, receipts };
}

it("keeps separate supported branches of one source and resolves renamed labels without copying them", async () => {
  const input = fixture(), resolved = await resolveResearchArrangement(input);
  expect(resolved.subjects.map(({ rowId, resource }) => ({ rowId, resource }))).toEqual([
    { rowId: "branch-0", resource: researchSourceResource(input.file.state.sources[sourceId].reference) },
    { rowId: "branch-1", resource: researchSourceResource(input.file.state.sources[sourceId].reference) },
  ]);
  expect(resolved.cells.map(({ content }) => content?.summary)).toEqual(["Obligations / Notice", "Obligations / Payment"]);
  expect(resolved.cells.map(({ content }) => content?.evidence)).toEqual(input.receipts.map((receipt) => [receipt]));
  expect(resolved.cells[0].content?.claims).toEqual([{ text: input.receipts[0].span_text,
    evidence_ids: [input.receipts[0].evidence_id] }]);
  input.file.state.labels[first].name = "Written notice";
  const renamed = await resolveResearchArrangement(input);
  expect(renamed.cells[0].content?.summary).toBe("Obligations / Written notice");
  expect(input.arrangement.cells[0].items[0]).not.toHaveProperty("name");
});

it("reads linked answers from their owning chat and retains their original support", async () => {
  const input = fixture(), resource = researchSourceResource(input.file.state.sources[sourceId].reference),
    answer = { claims: [{ text: "Notice can be emailed.", evidence_ids: [input.receipts[0].evidence_id] }], value: "Email" };
  input.arrangement.cells[0].items = [{ kind: "answer", chatId: "chat-1", answerId: "message-1:answer:0", resource }];
  const read = () => resolveResearchArrangement({ ...input, resolveFinding: async (reference) => ({ reference, kind: "answer", sourceId,
    resource, question: { id: "message-1:answer:0", title: "Notice", prompt: "How?" }, answer,
    evidence: [input.receipts[0]], origin: { chatId: "chat-1", messageId: "message-1" } }) });
  expect((await read()).cells[0].content).toMatchObject({ value: "Email", ...answer, evidence: [input.receipts[0]] });
  answer.value = "Written email";
  expect((await read()).cells[0].content?.value).toBe("Written email");
});

it("can project an ancestor separately while preserving the assignment to its supported leaf", async () => {
  const input = fixture();
  input.columns.push({ index: 5, name: "Category", prompt: "" });
  input.arrangement.cells.push({ rowId: "branch-0", columnIndex: 5, items: [{ kind: "label",
    sourceId, labelId: root, evidenceId: input.receipts[0].evidence_id }] });
  const result = await resolveResearchArrangement({ ...input, strict: true });
  expect(result.cells.find(({ column_index }) => column_index === 5)?.content?.value).toBe("Obligations");
  expect(result.cells[0].content?.value).toBe("Obligations / Notice");
});

it("isolates stale references to their cells and rejects them when saving a new arrangement", async () => {
  const input = fixture(); delete input.file.state.labels[first];
  const resolved = await resolveResearchArrangement(input);
  expect(resolved.cells.map(({ status }) => status)).toEqual(["error", "done"]);
  expect(resolved.cells[0].content).toBeNull();
  await expect(resolveResearchArrangement({ ...input, strict: true })).rejects.toMatchObject({ status: 409 });
});

it("rejects passages outside a row's chosen scope and answers from unlinked chats", async () => {
  const input = fixture(); input.arrangement.rows[0].evidenceIds = [input.receipts[1].evidence_id];
  await expect(resolveResearchArrangement({ ...input, strict: true })).rejects.toMatchObject({ status: 400 });
  input.arrangement.cells[0].items = [{ kind: "answer", chatId: "unrelated", answerId: "message-1:answer:0", resource: "source://other" }];
  await expect(resolveResearchArrangement({ ...input, strict: true })).rejects.toMatchObject({ status: 409 });
});

it("reads the live note on a source without copying it into the cell", async () => {
  const input = fixture();
  input.file.state.sources[sourceId].note = "Check the renewal window";
  input.columns.push({ index: 6, name: "Note", prompt: "The saved note" });
  input.arrangement.cells.push({ rowId: "branch-0", columnIndex: 6, items: [{ kind: "note", sourceId }] });
  const note = (cells: Awaited<ReturnType<typeof resolveResearchArrangement>>["cells"]) =>
    cells.find(({ column_index }) => column_index === 6)?.content;
  expect(note((await resolveResearchArrangement({ ...input, strict: true })).cells))
    .toMatchObject({ value: "Check the renewal window", evidence: [], claims: [] });
  input.file.state.sources[sourceId].note = "Renewed";
  expect(note((await resolveResearchArrangement({ ...input, strict: true })).cells)?.value).toBe("Renewed");
  expect(input.arrangement.cells.at(-1)!.items[0]).toEqual({ kind: "note", sourceId });
});
