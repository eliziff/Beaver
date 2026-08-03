import { describe, it, expect } from "vitest";
import {
  extractProvisionGraph,
  compileProvisionGraph,
  renderProvisionGraphSvg,
} from "../legalProvisionGraph";
import { compileAgreementSkeleton } from "../legalTextSkeleton";
import { crossReferenceGraph } from "../legalCrossReference";

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
  it("extracts nodes and edges from a cross-reference graph", () => {
    const skeleton = compileAgreementSkeleton(SAMPLE, "test");
    const xref = crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);

    // Structural nodes only (no table/row/cell)
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(["article", "part", "division", "section", "subsection", "schedule"]).toContain(node.kind);
      expect(node.label).toBeTruthy();
      expect(node.display).toBeTruthy();
      expect(typeof node.depth).toBe("number");
    }

    // Every edge should reference existing nodes
    const labels = new Set(graph.nodes.map((n) => n.label));
    for (const edge of graph.edges) {
      expect(labels.has(edge.from)).toBe(true);
      expect(labels.has(edge.to)).toBe(true);
      expect(["parent", "cross-reference"]).toContain(edge.kind);
    }

    // Should have parent edges
    const parents = graph.edges.filter((e) => e.kind === "parent");
    expect(parents.length).toBeGreaterThan(0);
  });

  it("resolves cross-references between sections", () => {
    const skeleton = compileAgreementSkeleton(SAMPLE, "test");
    const xref = crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);

    const xrefEdges = graph.edges.filter((e) => e.kind === "cross-reference");
    // "Section 6.01" should create edge from sec2.01 to sec6.01... but
    // sec6.01 doesn't exist in this sample, so it'll be unresolved/abstained.
    // "Section 7.02" — same.
    // "Section 8.01" in sec1.01(a) -> sec8.01 — this should resolve.
    const to801 = xrefEdges.find(
      (e) => e.from === "sec1.01(a)" && e.to === "sec8.01",
    );
    expect(to801).toBeDefined();
    expect(to801!.refText).toBe("Section 8.01");
  });

  it("does not include self-loops", () => {
    const text = "Section 2.01 Purchase Price. As provided in this Section 2.01, the price shall be $100.";
    const skeleton = compileAgreementSkeleton(text, "test");
    const xref = crossReferenceGraph(text, "test", { skeleton });
    const graph = extractProvisionGraph(xref);

    const selfEdges = graph.edges.filter(
      (e) => e.kind === "cross-reference" && e.from === e.to,
    );
    expect(selfEdges.length).toBe(0);
  });

  it("handles documents that abstain", () => {
    // A document with no section numbering at all
    const text = "This is a simple letter agreement with no numbered provisions.";
    const { graph, abstained } = compileProvisionGraph(text, "test");
    expect(abstained).toBe(true);
    expect(graph.edges.filter((e) => e.kind === "cross-reference").length).toBe(0);
  });
});

describe("renderProvisionGraphSvg", () => {
  it("produces valid SVG for a populated graph", () => {
    const skeleton = compileAgreementSkeleton(SAMPLE, "test");
    const xref = crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);
    const svg = renderProvisionGraphSvg(graph);

    expect(svg).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("pg-surface");
    expect(svg).toContain("pg-edge-parent");
    expect(svg).toContain("pg-edge-xref");
    // Should contain node labels
    expect(svg).toContain("sec2.01");
    expect(svg).toContain("sec8.01");
    // Dark mode support
    expect(svg).toContain("prefers-color-scheme: dark");
  });

  it("produces valid SVG for an empty graph", () => {
    const svg = renderProvisionGraphSvg({ nodes: [], edges: [] });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("0 nodes, 0 parent, 0 xref edges");
  });

  it("truncates when exceeding maxNodes", () => {
    const skeleton = compileAgreementSkeleton(SAMPLE, "test");
    const xref = crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);
    const svg = renderProvisionGraphSvg(graph, { maxNodes: 5 });

    expect(svg).toContain("Showing 5 of");
  });

  it("accepts custom sizing options", () => {
    const skeleton = compileAgreementSkeleton(SAMPLE, "test");
    const xref = crossReferenceGraph(SAMPLE, "test", { skeleton });
    const graph = extractProvisionGraph(xref);
    const svg = renderProvisionGraphSvg(graph, {
      width: 800,
      columnGap: 60,
      nodeHeight: 24,
      fontSize: 10,
    });

    expect(svg).toContain("width=\"800\"");
    expect(svg).toContain("font-size: 10px");
  });
});

describe("compileProvisionGraph", () => {
  it("is a convenience over extractProvisionGraph", () => {
    const a = compileProvisionGraph(SAMPLE, "test");
    const skeleton = compileAgreementSkeleton(SAMPLE, "test");
    const xref = crossReferenceGraph(SAMPLE, "test", { skeleton });
    const b = extractProvisionGraph(xref);

    expect(a.graph.nodes.length).toBe(b.nodes.length);
    expect(a.graph.edges.length).toBe(b.edges.length);
  });
});
