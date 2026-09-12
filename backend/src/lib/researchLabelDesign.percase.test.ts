import { describe, expect, it } from "vitest";
import { researchLabelInventory, researchLabelPlan } from "./researchLabelDesign";
import type { ResearchFile } from "./researchFile";
import type { ResearchImportCatalog } from "./tabular/researchImport";

const file = { document: { id: "f" }, state: { labels: {}, sources: {} } } as unknown as ResearchFile;
const catalog = { title: "Detention", fingerprint: "x", entries: [],
  rows: [{ id: "r1", sourceId: "s1", title: "R. v. Grant" }, { id: "r2", sourceId: "s2", title: "R. v. Omar" },
    { id: "r3", sourceId: "s3", title: "R. v. White" }] } as unknown as ResearchImportCatalog;
const design = (labels: { key: string; name: string; parentKey?: string | null; scope?: "source" | "highlight" }[],
  assignments: { labelKey: string; rowIds: string[] }[]) => ({ title: "Detention", labels, assignments });

describe("a label is a concept, never a document", () => {
  it("refuses a label named after one of the documents", () => {
    expect(() => researchLabelPlan(file, catalog,
      design([{ key: "a", name: "R. v. Grant" }], [{ labelKey: "a", rowIds: ["r1"] }]), "sources"))
      .toThrow(/names one source/u);
  });
  it("refuses a label set that copies the source list, one label per source (Eli, 2026-09-11)", () => {
    expect(() => researchLabelPlan(file, catalog, design(
      [{ key: "a", name: "Psychological detention" }, { key: "b", name: "Arbitrariness" }, { key: "c", name: "Exclusion" }],
      [{ labelKey: "a", rowIds: ["r1"] }, { labelKey: "b", rowIds: ["r2"] }, { labelKey: "c", rowIds: ["r3"] }]), "sources"))
      .toThrow(/copy the source list/u);
  });
  it("refuses one idea sitting in both hierarchies", () => {
    expect(() => researchLabelPlan(file, catalog, design(
      [{ key: "a", name: "Psychological detention" }, { key: "t", name: "Psychological detention", scope: "highlight" }],
      [{ labelKey: "a", rowIds: ["r1", "r2"] }]), "sources"))
      .toThrow(/both a label and a highlight type/u);
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

describe("the memo frames the inventory", () => {
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
    expect(inventory.memo).toEqual([
      { claim: "Detention runs from the first show of authority.", evidence: ["item0", "item4"] },
      { claim: "Race and age inform the reasonable person.", evidence: ["item0"] }]);
  });
  it("describes each source once and never restates the claims under it", () => {
    const inventory = JSON.parse(researchLabelInventory(framed, file, "sources"));
    expect(inventory.sources).toEqual([{ id: "r1", title: "R. v. Grant" }, { id: "r2", title: "R. v. Omar" }]);
    expect(inventory.passages).toEqual([{ id: "item0", source: "r1", quote: "A detention is a significant restraint." },
      { id: "item4", source: "r2", quote: "The officers were exerting dominion from entry." }]);
  });
});
