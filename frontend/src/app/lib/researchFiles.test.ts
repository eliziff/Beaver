import { describe, expect, it } from "vitest";
import { isResearchDocument, researchLabelPath, researchMarkdown } from "./researchFiles";

const document = (filename: string, file_type = "md") => ({
  id: "file", filename, file_type, project_id: null, pdf_storage_path: null,
  size_bytes: null, page_count: null, created_at: null,
});

describe("research files", () => {
  it("are ordinary Markdown documents with a compact embedded state", () => {
    expect(isResearchDocument(document("fairness.research.md"))).toBe(true);
    expect(isResearchDocument(document("fairness.md"))).toBe(false);
    expect(researchMarkdown("Fairness")).toContain("beaver-research:v1");
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
});
