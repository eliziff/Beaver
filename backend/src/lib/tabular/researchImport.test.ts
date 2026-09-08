import { expect, it } from "vitest";
import type { DocumentStore } from "../documentStore";
import { createA2AJPassageEvidence } from "../chat/legalEvidence";
import { createResearchFileState, researchReferenceFromEvidence, researchSourceResource,
  type ResearchEvidence, type ResearchFile } from "../researchFile";
import type { ResearchSubject } from "../researchSelection";
import { sha256 } from "../hash";
import { resolveResearchArrangement } from "./researchArrangement";
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

it("uses the set's concepts as columns and seeds only their supporting passages", async () => {
  const f = fixture(), result = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources" });
  expect(result.columns_config.map(({ name }) => name)).toEqual(["Contract", "Notice", "Payment"]);
  expect(result.columns_config.map(({ index }) => index)).toEqual([0, 1, 2]);
  expect(result.arrangement.rows).toEqual([{ id: sourceId, title: "Agreement", sourceId }]);
  expect(mapped(result).size).toBe(2);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: result.columns_config, arrangement: result.arrangement, storedCells: [], strict: true });
  expect(resolved.cells.map(({ status }) => status)).toEqual(["done", "done"]);
  expect(resolved.cells.map(({ content }) => content?.summary)).toEqual(f.receipts.map(({ span_text }) => span_text));
});

it("imports each passage once under its type without inventing answers in missing cells", async () => {
  const f = fixture(), all = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages" });
  expect(all.columns_config.map(({ name }) => name)).toEqual(["Contract", "Notice", "Payment"]);
  expect(all.arrangement.rows.map(({ id, title }) => ({ id, title }))).toEqual(f.receipts.map((receipt) =>
    ({ id: `${sourceId}:${receipt.evidence_id}`, title: `Agreement · ${receipt.locator.label}` })));
  expect(mapped(all).size).toBe(2);
  const penned = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages", labelId: notice });
  expect(penned.arrangement.rows.map(({ id }) => id)).toEqual([`${sourceId}:${f.receipts[0].evidence_id}`]);
  expect(penned.columns_config.map(({ name }) => name)).toEqual(["Contract", "Notice", "Payment"]);
  const resolved = await resolveResearchArrangement({ documents: f.documents, scope: { userId: "user-1" },
    file: f.file, columns: penned.columns_config, arrangement: penned.arrangement, storedCells: [], strict: true });
  expect(resolved.cells.map(({ content }) => content?.summary))
    .toEqual([f.receipts[0].span_text]);
});

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


it("does not seed highlight rows or highlight columns from background reads", () => {
  const f = fixture(), values = f.parts.get(sourceId)!;
  for (const item of Object.values(values)) item.labelIds = [];
  expect(researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "passages" }).arrangement.rows).toEqual([]);
  const sourceRows = researchTableArrangement(f.file, f.subjects, f.parts, [], { rows: "sources" });
  expect(sourceRows.columns_config.map(({ name }) => name)).toEqual(["Contract", "Notice", "Payment"]);
  expect(sourceRows.arrangement.cells).toEqual([]);
});

function finding(f: ReturnType<typeof fixture>, question: string, texts = ["Existing answer"], format = "text"): ResearchFinding {
  const resource = f.subjects[0].resource;
  return { reference: { kind: "answer", chatId: "chat", answerId: question, resource }, kind: "answer", sourceId, resource,
    question: { id: question, title: question, prompt: question, format },
    answer: { claims: texts.map((text, index) => ({ text, evidence_ids: [f.receipts[index % 2].evidence_id] })) },
    evidence: f.receipts, origin: { chatId: "chat", messageId: question } };
}
it("groups by actual question, not an entire chat, and offers individual original claims for semantic layouts", () => {
  const f = fixture(), first = finding(f, "Why invalid?", ["First reason", "Second reason"]),
    second = finding(f, "What wording?", ["Exact wording"]),
    catalog = researchImportCatalog(f.file, f.subjects, f.parts, [first, second], { rows: "sources" }),
    design = defaultResearchImport(catalog);
  expect(design.columns.map(({ name }) => name)).toEqual(["Contract", "Notice", "Payment"]);
  expect(catalog.entries.filter(({ reference }) => reference.kind === "answer" && reference.claimIndices).map(({ text }) => text))
    .toEqual(["First reason", "Second reason"]);
  const claim = catalog.entries.find(({ text }) => text === "Second reason")!;
  const plan = researchImportPlan(catalog, { title: "Reasons", columns: [{ index: 4, name: "Second reason", prompt: "Second reason?" }],
    cells: [{ rowId: sourceId, columnIndex: 4, itemIds: [claim.id] }] });
  expect(plan.arrangement.cells[0].items).toEqual([{ ...first.reference, claimIndices: [1] }]);
  expect(plan.samples[0].text).toBe("Second reason");
});
it("names the default highlight type for what it holds and reimports a question into its own column", () => {
  const f = fixture();
  f.file.state.labels[notice] = { ...f.file.state.labels[notice], name: "Highlight" };
  const repeat = finding(f, "Contract");
  // A review made from this research earlier comes back as a finding; it must not double the column.
  repeat.question = { ...repeat.question, title: "Classification",
    prompt: "Recorded source classifications; preserve their full paths." };
  const catalog = researchImportCatalog(f.file, f.subjects, f.parts, [repeat], { rows: "sources" });
  expect(defaultResearchImport(catalog).columns.map(({ name }) => name))
    .toEqual(["Contract", "Highlight", "Payment"]);
});
it("keeps narrowed answer claim indices and row support rather than re-indexing the original answer", () => {
  const f = fixture(), answer = finding(f, "Why?", ["Only selected claim"]);
  answer.reference = { ...answer.reference, claimIndices: [7] } as typeof answer.reference;
  const catalog = researchImportCatalog(f.file, f.subjects, f.parts, [answer], { rows: "sources" }),
    entry = catalog.entries.find(({ kind }) => kind === "answer")!;
  expect(entry.reference).toMatchObject({ claimIndices: [7] });
  expect(catalog.entries.filter(({ kind }) => kind === "answer")).toHaveLength(1);
});
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
it("leaves absence unanswered and preserves distinct scalar findings without choosing a winner", () => {
  const f = fixture(), a = finding(f, "Relevant?", ["Yes"], "yes_no"), b = finding(f, "Relevant?", ["No"], "yes_no");
  b.reference = { ...b.reference, answerId: "later" } as typeof b.reference;
  a.answer.value = true; b.answer.value = false;
  f.file.state.labels[topic].name = "Finding";
  const catalog = researchImportCatalog(f.file, f.subjects, f.parts, [a, b], { rows: "sources" }), design = defaultResearchImport(catalog);
  expect(design.columns[0].format).toBe("text");
  expect(design.cells.find(({ columnIndex }) => columnIndex === 0)?.itemIds).toHaveLength(2);
  const plan = researchImportPlan(catalog, { ...design, columns: [...design.columns, { index: 8, name: "Not researched", prompt: "New question?" }] });
  expect(plan.stats.at(-1)).toMatchObject({ reused: 0, evidence: 0 });
  expect(plan.arrangement.cells.some(({ columnIndex }) => columnIndex === 8)).toBe(false);
});
it("changes the preview fingerprint when original findings or classifications change", () => {
  const f = fixture(), answer = finding(f, "Why?");
  const catalog = () => researchImportCatalog(f.file, f.subjects, f.parts, [answer], { rows: "sources" });
  const original = catalog().fingerprint;
  answer.answer.claims[0].text = "Changed answer";
  expect(catalog().fingerprint).not.toBe(original);
  const changed = catalog().fingerprint;
  f.file.state.labels[topic].name = "Changed category";
  expect(catalog().fingerprint).not.toBe(changed);
});
it("uses the configured model only for a requested design and validates its returned references", async () => {
  const f = fixture(), catalog = researchImportCatalog(f.file, f.subjects, f.parts, [], { rows: "sources" });
  const { createTabularApplication } = await import("./application");
  let response = JSON.stringify(defaultResearchImport(catalog));
  const model = (await import("vitest")).vi.fn(async () => ({ fullText: response, status: "complete", events: [], citations: [] }));
  const app = createTabularApplication({} as never, {} as never, {} as never, { sources: async () => ({} as never),
    settings: async () => ({ title_model: "codex:gpt-5.6", api_keys: {} } as never), runTurn: model as never });
  const accepted = await app.designResearch({ userId: "owner" }, catalog, "Compare notice and payment");
  expect(accepted).toEqual(defaultResearchImport(catalog));
  expect(model.mock.calls).toHaveLength(1);
  response = JSON.stringify({ ...accepted, cells: [{ ...accepted.cells[0], itemIds: ["invented"] }] });
  await expect(app.designResearch({ userId: "owner" }, catalog, "Compare terms")).rejects.toMatchObject({ status: 502 });
  response = "Not valid JSON";
  await expect(app.designResearch({ userId: "owner" }, catalog, "Compare terms")).rejects.toMatchObject({ status: 502 });
  response = JSON.stringify({ ...accepted, columns: accepted.columns.slice(1), cells: [] });
  await expect(app.designResearch({ userId: "owner" }, catalog, "Use fewer columns"))
    .resolves.toMatchObject({ columns: accepted.columns.slice(1), cells: [] });
});
it("maps joint findings to each receipt's source without changing their full grounding", () => {
  const f = fixture(), other = createA2AJPassageEvidence({ citation: "Input 2", name: "Second agreement", dataset: "test", language: "en",
    sourceText: "Notice is required.", spanText: "Notice is required.", start: 0, end: 19,
    externalUrl: null, sourceClass: "case", sourceReference: { id: "input-2" } }),
    answer = finding(f, "Joint conclusion");
  answer.evidence.push(other);
  answer.answer.claims[0].evidence_ids.push(other.evidence_id);
  for (const rows of ["sources", "passages"] as const) {
    const catalog = researchImportCatalog(f.file, f.subjects, f.parts, [answer], { rows }),
      entries = catalog.entries.filter(({ kind }) => kind === "answer");
    expect(entries).toHaveLength(1);
    expect(entries[0].evidenceIds).toEqual([f.receipts[0].evidence_id]);
    expect(entries[0].reference).toEqual(answer.reference);
  }
  expect(answer.answer.claims[0].evidence_ids).toContain(other.evidence_id);
  expect(answer.evidence).toContain(other);
});
