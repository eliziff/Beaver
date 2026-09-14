import { describe, expect, it } from "vitest";
import { researchLabelDesignSchema, researchLabelInventory, researchLabelPlan } from "./researchLabelDesign";
import type { ResearchFile } from "./researchFile";
import type { ResearchImportCatalog } from "./tabular/researchImport";

const file = { document: { id: "f" }, state: { labels: {}, sources: {} } } as unknown as ResearchFile;
const catalog = { title: "Detention", fingerprint: "x", entries: [],
  rows: [{ id: "r1", sourceId: "s1", title: "R. v. Grant" }, { id: "r2", sourceId: "s2", title: "R. v. Omar" },
    { id: "r3", sourceId: "s3", title: "R. v. White" }] } as unknown as ResearchImportCatalog;
const design = (labels: { key: string; name: string; parentKey?: string | null; scope?: "source" | "highlight" }[],
  assignments: { labelKey: string; rowIds: string[] }[]) => ({ title: "Detention", labels, assignments });

describe("organization proposals preserve valid structures and exact membership", () => {
  it("assigns existing categories without redeclaring them and retains their review hierarchy", () => {
    const saved = { ...file, state: { ...file.state, labels: {
      parent: { id: "parent", name: "Detention", parentId: null, scope: "source", order: 0, color: null },
      child: { id: "child", name: "Psychological detention", parentId: "parent", scope: "source", order: 1, color: null },
    } } } as ResearchFile;
    const plan = researchLabelPlan(saved, catalog, design([], [{ labelKey: "child", rowIds: ["r1", "r2"] }]), "sources");
    expect(plan.actions).toEqual([{ type: "label-selection", target: "sources", sourceIds: ["s1", "s2"], assign: ["child"], mode: "add" }]);
    expect(plan.labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "child", parentId: "parent", existing: true, rows: expect.any(Array) }),
      expect.objectContaining({ id: "parent", existing: true }),
    ]));
    expect(() => researchLabelPlan(saved, catalog, design([], [{ labelKey: "unknown", rowIds: ["r1"] }]), "sources"))
      .toThrow("An assignment names an unknown label");
  });
  it("allows a source-named category when proposed", () => {
    expect(researchLabelPlan(file, catalog,
      design([{ key: "a", name: "R. v. Grant" }], [{ labelKey: "a", rowIds: ["r1"] }]), "sources"))
      .toMatchObject({ labels: [expect.objectContaining({ name: "R. v. Grant" })] });
  });
  it("allows useful distinctions that currently have one source each", () => {
    expect(researchLabelPlan(file, catalog, design(
      [{ key: "a", name: "Psychological detention" }, { key: "b", name: "Arbitrariness" }, { key: "c", name: "Exclusion" }],
      [{ labelKey: "a", rowIds: ["r1"] }, { labelKey: "b", rowIds: ["r2"] }, { labelKey: "c", rowIds: ["r3"] }]), "sources")
      .labels).toHaveLength(3);
  });
  it("allows the same concept to organize sources and highlights", () => {
    expect(researchLabelPlan(file, catalog, design(
      [{ key: "a", name: "Psychological detention" }, { key: "t", name: "Psychological detention", scope: "highlight" }],
      [{ labelKey: "a", rowIds: ["r1", "r2"] }]), "sources")
      .labels).toHaveLength(2);
  });
  it("accepts a concept ontology with the documents filed under it", () => {
    const plan = researchLabelPlan(file, catalog, design(
      [{ key: "a", name: "Detention under s. 9" }, { key: "b", name: "Psychological detention", parentKey: "a" },
        { key: "c", name: "s. 24(2) exclusion" }],
      [{ labelKey: "b", rowIds: ["r1", "r2"] }, { labelKey: "c", rowIds: ["r2", "r3"] }]), "sources");
    expect(plan.labels.map(({ name }) => name)).toContain("Psychological detention");
  });
  it("reuses case and plural variants on a second proposal", () => {
    const first = researchLabelPlan(file, catalog, design([{ key: "outcome", name: "Administrative outcome" }],
      [{ labelKey: "outcome", rowIds: ["r1", "r2", "r3"] }]), "sources"),
      labels = Object.fromEntries(first.actions.flatMap(action => action.type === "label" ? [[action.id!, action]] : [])),
      saved = { ...file, state: { ...file.state, labels } } as ResearchFile,
      second = researchLabelPlan(saved, catalog, design([{ key: "again", name: "ADMINISTRATIVE OUTCOMES" }],
        [{ labelKey: "again", rowIds: ["r1", "r2", "r3"] }]), "sources");
    expect(second.actions.some(action => action.type === "label")).toBe(false);
    expect(second.labels).toMatchObject([{ name: "Administrative outcome", existing: true }]);
  });
});

describe("answer excerpts frame the inventory", () => {
  const answer = (id: string, rowId: string, text: string, evidenceIds: string[], claimIndex?: number) =>
    ({ id, rowId, kind: "answer", text, evidenceIds, quotes: [], default: true, column: { index: 0, name: "Finding", prompt: "" },
      reference: { kind: "answer", chatId: "c1", answerId: "a1", resource: "case:1",
        ...(claimIndex === undefined ? {} : { claimIndices: [claimIndex] }) } });
  const passage = (id: string, rowId: string, text: string, evidenceId: string) =>
    ({ id, rowId, kind: "cited", text, evidenceIds: [evidenceId], quotes: [text], default: false,
      column: { index: 0, name: "Cited passage", prompt: "" }, reference: { kind: "passage", sourceId: rowId, evidenceId } });
  const framed = { ...catalog, question: "At what point was the client detained?", rows: catalog.rows.slice(0, 2),
    entries: [passage("item0", "r1", "A detention is a significant restraint.", "e1"),
      answer("item1", "r1", "Race and age inform the reasonable person.", ["e1"], 1),
      answer("item2", "r1", "Detention runs from the first show of authority.", ["e1"], 0),
      answer("item3", "r1", "Detention runs from the first show of authority.\n\nRace and age inform the reasonable person.", ["e1"]),
      passage("item4", "r2", "The officers were exerting dominion from entry.", "e2"),
      answer("item5", "r2", "Detention runs from the first show of authority.", ["e2"], 0)] } as unknown as ResearchImportCatalog;

  it("carries the question and each claim once, in order, with the passages it cites", () => {
    const inventory = JSON.parse(researchLabelInventory(framed, file, "sources"));
    expect(inventory.question).toBe("At what point was the client detained?");
    expect(inventory.answerExcerpts).toEqual([
      { claim: "Detention runs from the first show of authority.", evidence: ["item0", "item4"] },
      { claim: "Race and age inform the reasonable person.", evidence: ["item0"] }]);
  });
  it("derives source membership from inventory items without redundant row IDs", () => {
    const proposal = researchLabelDesignSchema.parse({ title: "Detention", labels: [{ key: "a", name: "Detention", scope: "source" }],
      assignments: [{ labelKey: "a", itemIds: ["item0", "item4"] }] });
    const plan = researchLabelPlan(file, framed, proposal, "sources");
    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "label-selection", target: "sources", sourceIds: ["s1", "s2"] }));
    expect(() => researchLabelPlan(file, framed, { ...proposal, assignments: [{ labelKey: "a", rowIds: ["r2"], itemIds: ["item0"] }] }, "sources"))
      .toThrow("A finding belongs to a row outside its assignment");
  });
  it("rejects conflicting highlight types for the same passage", () => {
    const proposal = researchLabelDesignSchema.parse({ title: "Detention", labels: [
      { key: "a", name: "Principle", scope: "highlight" }, { key: "b", name: "Application", scope: "highlight" }],
      assignments: [{ labelKey: "a", itemIds: ["item0"] }, { labelKey: "b", itemIds: ["item0"] }] });
    expect(() => researchLabelPlan(file, framed, proposal, "sources")).toThrow("A passage is assigned to more than one highlight type");
  });
  it("reparents and renames an existing category through the ordinary label operation", () => {
    const saved = { ...file, state: { ...file.state, labels: {
      parent: { id: "parent", name: "Detention", parentId: null, scope: "source", order: 0, color: null },
      child: { id: "child", name: "Psychological", parentId: null, scope: "source", order: 1, color: null },
    } } } as ResearchFile;
    const plan = researchLabelPlan(saved, catalog, design([
      { key: "child", name: "Psychological detention", parentKey: "parent" },
    ], [{ labelKey: "child", rowIds: ["r1", "r2"] }]), "sources");
    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "label", id: "child", parentId: "parent", name: "Psychological detention" }));
    expect(plan.labels.find(({ id }) => id === "child")).toMatchObject({ existing: true, path: "Detention / Psychological detention" });
    expect(saved.state.labels.child.parentId).toBeNull();
  });
  it("describes each source once and never restates the claims under it", () => {
    const inventory = JSON.parse(researchLabelInventory(framed, file, "sources"));
    expect(inventory.sources).toEqual([{ id: "r1", title: "R. v. Grant" }, { id: "r2", title: "R. v. Omar" }]);
    expect(inventory.passages).toEqual([{ id: "item0", source: "r1", quote: "A detention is a significant restraint." },
      { id: "item4", source: "r2", quote: "The officers were exerting dominion from entry." }]);
  });
});
