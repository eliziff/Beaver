import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { researchCategoryBudget, researchLabelDesignSchema, researchLabelDraft, researchLabelInventory, researchLabelMetadata, researchLabelModelView, researchLabelPlan } from "./researchLabelDesign";
import { researchSourceResource, type ResearchFile } from "./researchFile";
import { resolveChatFindings, selectFindingClaims } from "./researchChat";
import type { ChatMessageRecord } from "./chatStore";
import type { LegalEvidenceReceipt, ResearchEvidence, ResearchLabelDesign, ResearchSourceLabelNode, ResearchHighlightTypeNode } from "./researchContract";
import { researchImportCatalog, type ResearchImportCatalog } from "./tabular/researchImport";

const first = randomUUID(), second = randomUUID(), outside = randomUUID();
const node = (name: string, members: string[] = [], children: ResearchSourceLabelNode[] = []): ResearchSourceLabelNode => ({ id: randomUUID(), name, members, children });
const highlight = (name: string, members: ResearchHighlightTypeNode["members"] = [], children: ResearchHighlightTypeNode[] = []): ResearchHighlightTypeNode => ({ id: randomUUID(), name, members, children });
const design = (sourceLabels: ResearchSourceLabelNode[] = [], highlightTypes: ResearchHighlightTypeNode[] = []): ResearchLabelDesign => ({ title: "Research", sourceLabels, highlightTypes });
const file = { document: { id: randomUUID() }, state: { labels: {}, sources: {
  [first]: { id: first, collected: true, labelIds: [], reference: { kind: "case" } },
  [second]: { id: second, collected: true, labelIds: [], reference: { kind: "commentary" } },
} } } as unknown as ResearchFile;
const catalog = { title: "Detention", question: "When is a person detained?", labels: [], fingerprint: "x",
  rows: [{ id: first, sourceId: first, title: "Judgment" }, { id: second, sourceId: second, title: "Journal analysis" }],
  entries: [{ id: "item0", rowId: first, reference: { kind: "passage", sourceId: first, evidenceId: "e0:instance" },
    kind: "passages", text: "A reasonable person would not feel free to leave.", quotes: [], column: { name: "Existing type" }, evidenceIds: ["e0"] },
  { id: "item1", rowId: second, reference: { kind: "passage", sourceId: second, evidenceId: "e1" },
    kind: "cited", text: "The analysis depends on practical compulsion.", quotes: [], column: { name: "Cited passage" }, evidenceIds: ["e1"] }],
} as unknown as ResearchImportCatalog;

describe("canonical research organization", () => {
  it("scales one combined category budget from the number of sources", () => {
    expect(researchCategoryBudget(catalog)).toBe(12);
    const many = { ...catalog, rows: Array.from({ length: 20 }, (_, index) => ({ id: `row${index}`,
      sourceId: randomUUID(), title: `Source ${index}` })) } as unknown as ResearchImportCatalog;
    expect(researchCategoryBudget(many)).toBe(40);
    const nodes = Array.from({ length: 13 }, (_, index) => ({ name: `Issue ${index}` }));
    expect(() => researchLabelDraft({ title: "Research", sourceLabels: nodes, highlightTypes: [] }, catalog, file,
      undefined, researchCategoryBudget(catalog))).toThrow("at most 12 categories");
  });
  it("compiles deep trees directly and keeps judgment and journal memberships together", () => {
    const leaf = node("Security already worthless", [first, second]), waiver = node("Waiver", [second]),
      root = node("Preservation of security", [], [node("Prejudice to recourse", [], [node("No prejudice found", [], [leaf])]), waiver]),
      plan = researchLabelPlan(file, catalog, design([root]), "sources");
    expect(plan.labels.find(({ id }) => id === leaf.id)).toMatchObject({ path: "Preservation of security / Prejudice to recourse / No prejudice found / Security already worthless",
      rows: [{ id: first, title: "Judgment", support: [] }, { id: second, title: "Journal analysis", support: [] }] });
    expect(plan.actions).toContainEqual({ type: "label-selection", target: "sources", sourceIds: [first, second], assign: [leaf.id], mode: "add" });
  });
  it("resolves compact refs once and retains exact saved highlight instances", () => {
    const raw = { title: "Detention", sourceLabels: [{ name: "Detention", children: [{ name: "Psychological detention", members: ["s0", "s1"] }] }],
      highlightTypes: [{ name: "Compulsion", members: ["item0", "item1"] }] },
      parsed = researchLabelDraft(raw, catalog, file), child = parsed.sourceLabels[0].children[0];
    expect(child.members).toEqual([first, second]);
    expect(parsed.highlightTypes[0].members).toEqual([{ sourceId: first, evidenceId: "e0:instance" }, { sourceId: second, evidenceId: "e1" }]);
    expect(researchLabelPlan(file, catalog, parsed, "sources").actions).toContainEqual({ type: "annotate", kind: "evidence", sourceId: first, id: "e0:instance", labelIds: [parsed.highlightTypes[0].id] });
    expect(researchLabelModelView(parsed, catalog)).toMatchObject(raw);
    const revised = researchLabelDraft(raw, catalog, file, parsed);
    expect(revised.sourceLabels[0].id).toBe(parsed.sourceLabels[0].id);
    expect(revised.sourceLabels[0].children[0].id).toBe(child.id);
  });
  it("uses one source alias when several selected passage rows belong to it", () => {
    const passageCatalog = { ...catalog, rows: [{ id: "p0", sourceId: first, evidenceIds: ["e0"], title: "Judgment" },
      { id: "p1", sourceId: first, evidenceIds: ["e2"], title: "Judgment" }], entries: [] },
      inventory = JSON.parse(researchLabelInventory(passageCatalog, file, "passages"));
    expect(inventory.sources).toHaveLength(1);
    expect(researchLabelDraft({ title: "Research", sourceLabels: [{ name: "Detention", members: ["s0"] }], highlightTypes: [] }, passageCatalog, file).sourceLabels[0].members).toEqual([first]);
  });
  it("rejects obsolete flat proposals, repeated node IDs and mismatched source/passage pairs", () => {
    expect(researchLabelDesignSchema.safeParse({ title: "Research", labels: [], assignments: [] }).success).toBe(false);
    const category = node("Issue");
    expect(researchLabelDesignSchema.safeParse(design([category, category])).success).toBe(false);
    expect(() => researchLabelPlan(file, catalog, design([], [highlight("Rule", [{ sourceId: second, evidenceId: "e0:instance" }])]), "sources"))
      .toThrow("outside this research");
    expect(() => researchLabelDraft({ title: "Research", sourceLabels: [{ id: randomUUID(), name: "Invented" }], highlightTypes: [] }, catalog, file)).toThrow("id must identify");
  });
  it("rejects assigning one highlight instance to two types", () => {
    const member = { sourceId: first, evidenceId: "e0:instance" };
    expect(() => researchLabelPlan(file, catalog, design([], [highlight("A", [member]), highlight("B", [member])]), "sources"))
      .toThrow('assigned to both "A" and "B"');
  });
  it("leaves an omitted saved passage as plain Highlight", () => {
    const generic = randomUUID(), saved = { ...file, state: { ...file.state, labels: { [generic]: {
      id: generic, name: "Highlight", parentId: null, order: 0, scope: "highlight" as const, color: null } } } },
      plan = researchLabelPlan(saved, catalog, design([node("Subrogation", [first])]), "sources");
    expect(plan.actions).toContainEqual({ type: "annotate", kind: "evidence", sourceId: first,
      id: "e0:instance", labelIds: [generic] });
  });
  it("reconciles selected memberships while preserving outside sources and required ancestors", () => {
    const existing = node("Old organization", [first, outside]), newNode = node("New organization", [second]),
      saved = { ...file, state: { ...file.state, labels: { [existing.id]: { ...existing, parentId: null, order: 0, scope: "source" as const, color: null } },
        sources: { ...file.state.sources, [first]: { ...file.state.sources[first], labelIds: [existing.id] },
          [outside]: { ...file.state.sources[first], id: outside, labelIds: [existing.id] } } } },
      plan = researchLabelPlan(saved, catalog, design([newNode]), "sources");
    expect(plan.actions).toContainEqual({ type: "label-selection", target: "sources", sourceIds: [first], assign: [existing.id], mode: "remove" });
    expect(plan.actions.some((action) => action.type === "remove" && action.id === existing.id)).toBe(false);
    expect(researchLabelPlan(saved, catalog, design([newNode]), "sources", "file").actions.some((action) => action.type === "label-selection" && action.mode === "remove")).toBe(false);
  });
  it("persists definitions and colors and removes omitted categories exclusively used by selected sources", () => {
    const original = node("Issue", [first]), old = node("Obsolete", [second]),
      saved = { ...file, state: { ...file.state, labels: Object.fromEntries([original, old].map((item) => [item.id,
        { ...item, parentId: null, order: 0, scope: "source" as const, color: null }])),
        sources: { ...file.state.sources, [second]: { ...file.state.sources[second], labelIds: [old.id] } } } },
      updated = { ...original, members: [], color: "#223344", definition: "The governing issue" },
      plan = researchLabelPlan(saved, catalog, design([updated]), "sources");
    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "label", id: original.id, definition: updated.definition, color: updated.color }));
    expect(plan.actions).toContainEqual({ type: "remove", kind: "label", id: old.id });
  });
  it("preserves an untouched descendant when organizing only part of the workspace", () => {
    const parent = node("Existing parent", [first]), child = node("Unselected empty child"),
      saved = { ...file, state: { ...file.state, labels: {
        [parent.id]: { ...parent, parentId: null, order: 0, scope: "source" as const, color: null },
        [child.id]: { ...child, parentId: parent.id, order: 0, scope: "source" as const, color: null },
      }, sources: { ...file.state.sources, [first]: { ...file.state.sources[first], labelIds: [parent.id] },
        [outside]: { ...file.state.sources[first], id: outside } } } },
      plan = researchLabelPlan(saved, catalog, design([node("New organization", [first])]), "sources");
    expect(plan.actions.some((action) => action.type === "remove")).toBe(false);
    expect(plan.actions).toContainEqual({ type: "label-selection", target: "sources", sourceIds: [first], assign: [parent.id], mode: "remove" });
  });
  it.each(["answer", "subagent"])("preserves original %s claim identities through source grouping and narrowing", (kind) => {
    const ids = [first, second, outside], version = randomUUID(),
      sources = ids.map((id, index) => ({ id, collected: true, labelIds: [], note: "", passages: null,
        reference: { provider: "library" as const, kind: "document" as const, id, versionId: version, title: `Source ${index}` } })),
      sourceFile = { ...file, state: { ...file.state, sources: Object.fromEntries(sources.map((source) => [source.id, source])) } },
      receipts: LegalEvidenceReceipt[] = ids.map((id, index) => ({ evidence_id: `e_${index}`, provider: "library", jurisdiction: "CA",
        source_class: "commentary", stable_source_id: id, source_sha256: "a".repeat(64), scope: "passage", block_id: "1",
        span_sha256: "b".repeat(64), span_text: `Original passage ${index}`, citation: "", name: `Source ${index}`,
        dataset: "Library", language: "en", version, external_url: null, locator: { kind: "paragraph", label: "1" }, resolver_version: "library-read-v1" })),
      claims = [{ text: "First source's distinct claim", evidence_ids: ["e_0"] },
        { text: "Second source's distinct claim", evidence_ids: ["e_1"] },
        { text: "Shared claim", evidence_ids: ["e_0", "e_1"] },
        { text: "Third source's singleton claim", evidence_ids: ["e_2"] }],
      event = kind === "answer" ? { type: "legal_evidence_receipt", status: "passed", claims, evidence: receipts, queries: [] }
        : { type: "subagent_run", id: "reader", status: "completed", task: "Research", grounding: { status: "passed", claims, evidence: receipts, queries: [] } },
      messages = [{ id: "message", role: "assistant", content: [event] }] as unknown as ChatMessageRecord[],
      findings = resolveChatFindings(sourceFile, "chat", messages),
      parts = new Map<string, Record<string, ResearchEvidence>>(receipts.map((receipt, index) => [ids[index], {
        [receipt.evidence_id]: { receipt, sourceId: ids[index], labelIds: [], note: "" } }]));
    for (const ordered of [sources, [...sources].reverse()]) {
      const imported = researchImportCatalog(sourceFile, ordered.map(({ id: sourceId, reference }) =>
        ({ sourceId, reference, resource: researchSourceResource(reference) })), parts, findings, { rows: "sources" }),
        inventory = JSON.parse(researchLabelInventory(imported, sourceFile, "sources")),
        byItem = new Map(imported.entries.map((entry) => [entry.id, entry.evidenceIds]));
      expect(inventory.answerExcerpts.map((entry: { claim: string; evidence: string[] }) => ({ text: entry.claim,
        evidence_ids: entry.evidence.flatMap((id) => byItem.get(id) ?? []).sort() }))).toEqual(claims);
    }
    const finding = findings.find(({ sourceId }) => sourceId === first)!, reference = finding.reference;
    if (reference.kind !== "answer") throw new Error("Expected chat finding");
    const selected = selectFindingClaims(finding, { ...reference, claimIndices: [2, 0, 2] });
    expect(selected.reference).toMatchObject({ claimIndices: [0, 2] });
    expect(selectFindingClaims(selected, { ...reference, claimIndices: [2] }).answer.claims).toEqual([claims[2]]);
    expect(() => selectFindingClaims(finding, { ...reference, claimIndices: [1] })).toThrow("unavailable");
  });
  it("keeps passage previews and support distinct from findings and notes citing the same evidence", () => {
    const answer: ResearchImportCatalog["entries"][number] = { id: "answer", rowId: second, kind: "answer", default: false, text: "Commentary discussing the source.",
      reference: { kind: "answer", chatId: "chat", answerId: "answer", resource: "journal", claimIndices: [0] },
      evidenceIds: ["e1"], quotes: [catalog.entries[0].text, catalog.entries[1].text], column: { index: 0, name: "Finding", prompt: "What does the source explain?", format: "text" } },
      mixed: ResearchImportCatalog = { ...catalog, entries: [...catalog.entries, answer, { ...answer, id: "note", kind: "note", text: "My note", quotes: [],
        reference: { kind: "note", sourceId: second, evidenceId: "e1" } }] },
      metadata = researchLabelMetadata(mixed),
      plan = researchLabelPlan(file, mixed, design([], [highlight("Compulsion", metadata.items.map(({ sourceId, evidenceId }) => ({ sourceId, evidenceId })))]), "sources");
    expect(metadata.items).toEqual([
      { sourceId: first, evidenceId: "e0:instance", title: "Judgment", text: catalog.entries[0].text },
      { sourceId: second, evidenceId: "e1", title: "Journal analysis", text: catalog.entries[1].text },
    ]);
    expect(plan.labels[0].rows.map(({ support }) => support)).toEqual(catalog.entries.map(({ text }) => [text]));
    expect(JSON.parse(researchLabelInventory(mixed, file, "sources")).answerExcerpts)
      .toEqual([{ claim: answer.text, evidence: ["item1"] }]);
  });
});
