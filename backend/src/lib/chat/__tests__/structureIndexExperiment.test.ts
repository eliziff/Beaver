import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SkeletonNode } from "../../legalTextSkeleton";
import {
  attachStructureIndex,
  deriveSectionNodes,
  renderStructureIndex,
} from "../structureIndexExperiment";

function node(partial: Partial<SkeletonNode> & { kind: SkeletonNode["kind"] }): SkeletonNode {
  return {
    label: partial.label ?? "sec1",
    display: partial.display ?? "Section 1",
    heading: partial.heading ?? "",
    depth: 0,
    start: 0,
    end: 0,
    ...partial,
  };
}

describe("structureIndexExperiment (silo'd LAB arm)", () => {
  describe("renderStructureIndex", () => {
    it("includes article/section/subsection/schedule kinds and excludes table/row/cell", () => {
      const nodes: SkeletonNode[] = [
        node({ kind: "article", label: "art1", display: "ARTICLE I", heading: "DEFINITIONS" }),
        node({ kind: "section", label: "sec1.01", display: "Section 1.01", heading: "Defined Terms" }),
        node({ kind: "subsection", label: "sec2.01(a)", display: "Section 2.01(a)", heading: "Subject to the terms and conditions set forth herein, each Lender severally agrees" }),
        node({ kind: "schedule", label: "sched7.01", display: "SCHEDULE 7.01", heading: "Commitments" }),
        node({ kind: "table", label: "table:1/row:1/col:1", display: "Table 1", heading: "" }),
        node({ kind: "row", label: "row", display: "Row", heading: "" }),
        node({ kind: "cell", label: "cell", display: "Cell", heading: "" }),
      ];
      const index = renderStructureIndex(nodes);
      expect(index).toContain("4 numbered sections/parts");
      expect(index).toContain("ARTICLE I");
      expect(index).toContain("Section 1.01 — Defined Terms");
      expect(index).toContain("Section 2.01(a)");
      expect(index).toContain("SCHEDULE 7.01");
      expect(index).not.toContain("Table 1");
      expect(index).not.toContain("Row");
      expect(index).not.toContain("Cell");
    });

    it("truncates long headings but keeps a searchable prefix", () => {
      const nodes = [
        node({
          kind: "subsection",
          label: "sec2.01(a)",
          display: "Section 2.01(a)",
          heading: "Subject to the terms and conditions set forth herein, each Lender severally agrees to make a term loan",
        }),
      ];
      const index = renderStructureIndex(nodes);
      // a stable, searchable prefix survives the 64-char truncation
      expect(index).toContain("Subject to the terms and conditions set forth herein");
      expect(index).toContain("…");
    });

    it("returns empty string when no derived spine exists", () => {
      expect(renderStructureIndex([node({ kind: "table", label: "t" })])).toBe("");
      expect(renderStructureIndex([])).toBe("");
    });
  });

  describe("attachStructureIndex", () => {
    it("prepends the index without altering the markdown body", () => {
      const markdown = "**Section 1.01 — Defined Terms**\n\nBody text.";
      const index = renderStructureIndex([
        node({ kind: "section", label: "sec1.01", display: "Section 1.01", heading: "Defined Terms" }),
      ]);
      const attached = attachStructureIndex(markdown, index);
      expect(attached.startsWith(`SECT-INDEX`)).toBe(true);
      expect(attached).toContain(`\n\n${markdown}`);
    });

    it("returns the markdown unchanged when the index is empty", () => {
      const markdown = "**Body**";
      expect(attachStructureIndex(markdown, "")).toBe(markdown);
    });
  });

  describe("deriveSectionNodes (consumes existing .docx detectors)", () => {
    const path =
      "C:/Users/elias/Desktop/MikeOSS Fork/benchmarks/harvey-labs/tasks/banking-finance/extract-credit-agreement-covenants/documents/credit-agreement.docx";
    it.skipIf(!existsSync(path))("derives the section tree incl. composed subsections", async () => {
      const nodes = await deriveSectionNodes(readFileSync(path));
      const kinds = new Set(nodes.map((n) => n.kind));
      expect(kinds.has("article")).toBe(true);
      expect(kinds.has("section")).toBe(true);
      expect(kinds.has("subsection")).toBe(true);
      const composed = nodes.find((n) => n.label === "sec2.01(a)");
      expect(composed).toBeDefined();
      expect(composed!.display).toBe("Section 2.01(a)");
    });
  });
});
