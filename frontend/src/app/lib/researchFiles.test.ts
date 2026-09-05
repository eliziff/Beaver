import { describe, expect, it } from "vitest";
import { isResearchDocument, newResearchState, researchLabelPath,
  researchMarkdown, researchSourceKey } from "./researchFiles";

const document = (filename: string, file_type = "md") => ({
  id: "file", filename, file_type, project_id: null, pdf_storage_path: null,
  size_bytes: null, page_count: null, created_at: null,
});

describe("research files", () => {
  it("are ordinary Markdown documents with a compact embedded state", () => {
    expect(isResearchDocument(document("fairness.research.md"))).toBe(true);
    expect(isResearchDocument(document("fairness.md"))).toBe(false);
    expect(researchMarkdown("Fairness")).toContain("beaver-research:v2");
    expect(newResearchState()).toEqual({ schemaVersion: "beaver.research.v2",
      labels: {}, sources: {}, queries: null, note: "" });
  });

  it("derives hierarchy safely instead of storing copied paths", () => {
    const labels = {
      root: { id: "root", name: "Public law", parentId: null, color: null },
      child: { id: "child", name: "Fairness", parentId: "root", color: null },
    };
    expect(researchLabelPath(labels, "child").map(({ name }) => name)).toEqual(["Public law", "Fairness"]);
    labels.root.parentId = "child";
    expect(researchLabelPath(labels, "child")).toHaveLength(2);
  });

  it("keys the complete durable source identity", () => {
    const source = { provider: "a2aj", id: "case", kind: "case" as const };
    expect(researchSourceKey({ ...source, language: "en" }))
      .not.toBe(researchSourceKey({ ...source, language: "fr" }));
    const courtListener = { ...source, provider: "courtlistener" };
    expect(researchSourceKey(courtListener))
      .toBe(researchSourceKey({ ...courtListener, collection: "courtlistener" }));
    expect(researchSourceKey({ ...source, collection: "SCC" }))
      .not.toBe(researchSourceKey({ ...source, collection: "ABCA" }));
  });
});
