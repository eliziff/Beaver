import { describe, expect, it } from "vitest";
import { researchLabelPlan } from "./researchLabelDesign";
import type { ResearchFile } from "./researchFile";
import type { ResearchImportCatalog } from "./tabular/researchImport";

const file = { document: { id: "f" }, state: { labels: {}, sources: {} } } as unknown as ResearchFile;
const catalog = { title: "Detention", fingerprint: "x", entries: [],
  rows: [{ id: "r1", sourceId: "s1", title: "R. v. Grant" }, { id: "r2", sourceId: "s2", title: "R. v. Omar" },
    { id: "r3", sourceId: "s3", title: "R. v. White" }] } as unknown as ResearchImportCatalog;
const design = (labels: { key: string; name: string; parentKey?: string | null }[],
  assignments: { labelKey: string; rowIds: string[] }[]) => ({ title: "Detention", labels, assignments });

describe("a label is a concept, never a document", () => {
  it("refuses a label named after one of the documents", () => {
    expect(() => researchLabelPlan(file, catalog,
      design([{ key: "a", name: "R. v. Grant" }], [{ labelKey: "a", rowIds: ["r1"] }]), "sources"))
      .toThrow(/names one document/u);
  });
  it("refuses an ontology that is one label per document", () => {
    expect(() => researchLabelPlan(file, catalog, design(
      [{ key: "a", name: "Psychological detention" }, { key: "b", name: "Arbitrariness" }, { key: "c", name: "Exclusion" }],
      [{ labelKey: "a", rowIds: ["r1"] }, { labelKey: "b", rowIds: ["r2"] }, { labelKey: "c", rowIds: ["r3"] }]), "sources"))
      .toThrow(/single document/u);
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
