import { describe, it, expect } from "vitest";
import {
  extractProvisionGraph,
  compileProvisionGraph,
  renderProvisionGraphHtml,
} from "../../../experiments/provision_graph/provisionGraph";
import { compileAgreementSkeleton } from "../../src/lib/legalTextSkeleton";
import { crossReferenceGraph } from "../../src/lib/legalCrossReference";

const SAMPLE = `ARTICLE I — DEFINITIONS

Section 1.01 Defined Terms. As used in this Agreement:

(a) "Affiliate" shall have the meaning set forth in Section 8.01.
(b) "Business Day" means any day other than Saturday, Sunday or a legal holiday.

Section 1.02 Construction. Unless the context otherwise requires.

ARTICLE II — PURCHASE AND SALE

Section 2.01 Purchase and Sale. Subject to Section 6.01 and Section 7.02, at the Closing, Seller shall sell to Buyer the Shares.

Section 8.01 Termination. This Agreement may be terminated in accordance with this Section 8.01.
`;

describe("extractProvisionGraph", () => {
  it("extracts nodes and edges from a cross-reference graph", async () => {
    const skeleton = await compileAgreementSkeleton(SAMPLE, "test");
    const xref = await crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);

    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(["article", "part", "division", "section", "subsection", "schedule"]).toContain(node.kind);
      expect(node.label).toBeTruthy();
      expect(node.display).toBeTruthy();
      expect(typeof node.depth).toBe("number");
    }

    const labels = new Set(graph.nodes.map((n) => n.label));
    for (const edge of graph.edges) {
      expect(labels.has(edge.from)).toBe(true);
      expect(labels.has(edge.to)).toBe(true);
      expect(["parent", "cross-reference"]).toContain(edge.kind);
    }

    const parents = graph.edges.filter((e) => e.kind === "parent");
    expect(parents.length).toBeGreaterThan(0);
  });

  it("resolves cross-references between sections", async () => {
    const skeleton = await compileAgreementSkeleton(SAMPLE, "test");
    const xref = await crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);

    const xrefEdges = graph.edges.filter((e) => e.kind === "cross-reference");
    const to801 = xrefEdges.find(
      (e) => e.from === "sec1.01(a)" && e.to === "sec8.01",
    );
    expect(to801).toBeDefined();
    expect(to801!.refText).toBe("Section 8.01");
  });

  it("does not include self-loops", async () => {
    const text = "Section 2.01 Purchase Price. As provided in this Section 2.01, the price shall be $100.";
    const skeleton = await compileAgreementSkeleton(text, "test");
    const xref = await crossReferenceGraph(text, "test", { skeleton });
    const graph = extractProvisionGraph(xref);

    const selfEdges = graph.edges.filter(
      (e) => e.kind === "cross-reference" && e.from === e.to,
    );
    expect(selfEdges.length).toBe(0);
  });

  it("handles documents that abstain", async () => {
    const text = "This is a simple letter agreement with no numbered provisions.";
    const { graph, abstained } = await compileProvisionGraph(text, "test");
    expect(abstained).toBe(true);
    expect(graph.edges.filter((e) => e.kind === "cross-reference").length).toBe(0);
  });
});

describe("renderProvisionGraphHtml", () => {
  it("produces valid HTML with cytoscape", async () => {
    const skeleton = await compileAgreementSkeleton(SAMPLE, "test");
    const xref = await crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);
    const html = renderProvisionGraphHtml(graph);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("cytoscape");
    expect(html).toContain("dagre");
    // Should contain node data
    expect(html).toContain("sec2.01");
    expect(html).toContain("sec8.01");
    // Should have view buttons
    expect(html).toContain("btn-graph");
    expect(html).toContain("btn-tree");
    // Should have search
    expect(html).toContain("search");
    // Dark mode
    expect(html).toContain("prefers-color-scheme");
  });

  it("produces valid HTML for an empty graph", () => {
    const html = renderProvisionGraphHtml({ nodes: [], edges: [] });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("truncates when exceeding maxNodes", async () => {
    const skeleton = await compileAgreementSkeleton(SAMPLE, "test");
    const xref = await crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);
    const html = renderProvisionGraphHtml(graph, { maxNodes: 5 });

    expect(html).toContain("Showing 5 of");
  });

  it("accepts custom title", async () => {
    const skeleton = await compileAgreementSkeleton(SAMPLE, "test");
    const xref = await crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);
    const html = renderProvisionGraphHtml(graph, { title: "My Agreement" });

    expect(html).toContain("<title>My Agreement</title>");
  });
});

describe("compileProvisionGraph", () => {
  it("is a convenience over extractProvisionGraph", async () => {
    const a = await compileProvisionGraph(SAMPLE, "test");
    const skeleton = await compileAgreementSkeleton(SAMPLE, "test");
    const xref = await crossReferenceGraph(SAMPLE, "test", { skeleton });
    const b = extractProvisionGraph(xref);

    expect(a.graph.nodes.length).toBe(b.nodes.length);
    expect(a.graph.edges.length).toBe(b.edges.length);
  });
});
