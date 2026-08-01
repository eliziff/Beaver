import { describe, expect, it } from "vitest";

import { compileAgreementSkeleton } from "../legalTextSkeleton";
import {
  crossReferenceGraph,
  definedTermEdges,
  lexicalOverlapEdges,
} from "../legalCrossReference";

/**
 * The agreement fixture is drafted in the mini corpus's own dialect
 * (numbered "Section N.NN" headings under roman ARTICLE containers, the
 * shape of every maud merger agreement) and is deliberately small enough
 * that every edge in it can be reasoned about by hand.
 */
const AGREEMENT = [
  "ARTICLE I DEFINITIONS",
  "",
  "Section 1.1 Definitions. The Termination Fee is payable under Section 7.3.",
  "",
  "Section 1.2 Interpretation. References to a Section are references to a Section of this Agreement.",
  "",
  "ARTICLE VI CONDITIONS",
  "",
  "Section 6.1 Conditions. The obligations of each party are subject to Section 6.2 and Article VII.",
  "",
  "Section 6.2 Mutual Conditions. Subject to Section 85 of the Income Tax Act, the following apply:",
  "(a) no injunction is in effect;",
  "(b) the approvals in clause (a) have been obtained.",
  "",
  "ARTICLE VII TERMINATION",
  "",
  "Section 7.1 Termination. This Agreement may be terminated as set forth in Section 7.3.",
  "",
  'Section 7.3 Termination Fee. The Company shall pay a fee (the "Termination Fee") in accordance with Section 6.2(b).',
  "",
].join("\n");

const graphOf = (text: string) => crossReferenceGraph(text, "fixture");

describe("crossReferenceGraph — literal edges", () => {
  it("resolves an internal reference to the target section's span", () => {
    const graph = graphOf(AGREEMENT);
    const edge = graph.edges.find((e) => e.raw === "Section 6.2" && e.status === "resolved");
    expect(edge).toBeDefined();
    expect(edge!.normalizedLocator).toBe("sec6.2");
    expect(edge!.targetLabel).toBe("sec6.2");
    expect(AGREEMENT.slice(edge!.targetStart!, edge!.targetEnd!)).toContain(
      "Mutual Conditions",
    );
    // the edge's own span is the reference text
    expect(AGREEMENT.slice(edge!.sourceStart, edge!.sourceEnd)).toBe("Section 6.2");
    expect(edge!.sourceLabel).toBe("sec6.1");
  });

  it("resolves a roman container reference through the skeleton alias", () => {
    const edge = graphOf(AGREEMENT).edges.find((e) => e.raw === "Article VII");
    expect(edge?.status).toBe("resolved");
    expect(edge?.normalizedLocator).toBe("article vii");
    expect(edge?.targetLabel).toBe("art7");
  });

  it("resolves a sub-only reference relative to the section it sits in", () => {
    const edge = graphOf(AGREEMENT).edges.find((e) => e.raw === "clause (a)");
    expect(edge?.normalizedLocator).toBe("sec6.2(a)");
    expect(edge?.status).toBe("resolved");
    expect(edge?.targetLabel).toBe("sec6.2(a)");
  });

  it("classifies a reference to another instrument as external, not unresolved", () => {
    const edge = graphOf(AGREEMENT).edges.find((e) => e.raw === "Section 85");
    expect(edge?.status).toBe("external");
    expect(edge?.reason).toBe("external_instrument");
    expect(edge?.targetLabel).toBeNull();
  });

  it("marks a reference that points at its own section as a self-loop", () => {
    const graph = graphOf(AGREEMENT);
    const selfLoops = graph.edges.filter((e) => e.selfLoop);
    expect(graph.counts.selfLoops).toBe(selfLoops.length);
    for (const edge of selfLoops) expect(edge.targetLabel).toBe(edge.sourceLabel);
  });

  it("counts every edge exactly once across the five dispositions", () => {
    const { counts, edges } = graphOf(AGREEMENT);
    expect(counts.detected).toBe(edges.length);
    expect(
      counts.resolved + counts.external + counts.unresolved + counts.abstained,
    ).toBe(counts.detected);
  });

  it("does not treat a decimal provision as the child or fallback target of an integer provision", () => {
    const text = [
      "Section 149 Previous. Section 150 applies.",
      "Section 150.1 Distinct decimal provision.",
      "Section 151 Following.",
      "Section 152 Following.",
      "Section 153 Following.",
    ].join("\n\n");
    const edge = crossReferenceGraph(text, "decimal-reference", {
      integrityThreshold: 0,
    }).edges.find((candidate) => candidate.raw === "Section 150");

    expect(edge?.status).toBe("unresolved");
    expect(edge?.targetLabel).toBeNull();
    expect(edge?.reason).toBe("no_such_provision");
  });
});

describe("crossReferenceGraph — typed refusals", () => {
  it("abstains wholesale when the skeleton is too thin to resolve against", () => {
    const graph = graphOf(
      "We may terminate under Section 4.2 and Section 9.1 at any time.",
    );
    expect(graph.documentAbstained).toBe(true);
    expect(graph.note).toMatch(/addressable provision/u);
    expect(graph.counts.unresolved).toBe(0);
    for (const edge of graph.edges) {
      expect(edge.status).toBe("abstained");
      expect(edge.reason).toBe("document_abstained");
    }
  });

  it("abstains when the document does not number to the referenced depth", () => {
    // Section 6.2 has anchored children; Section 7.3 has none, so a
    // reference to 7.3(c) says nothing about the document.
    const edge = graphOf(
      `${AGREEMENT}\nSection 7.4 Notices. See Section 7.3(c) for details.\n`,
    ).edges.find((e) => e.raw === "Section 7.3(c)");
    expect(edge?.status).toBe("abstained");
    expect(edge?.reason).toBe("depth_not_numbered");
  });

  it("reports a genuine dangling reference as unresolved", () => {
    // 6.2 numbers to (a)/(b); (z) is a real gap, not a detector blind spot.
    const edge = graphOf(
      AGREEMENT.replace("the approvals in clause (a)", "the approvals in clause (z)"),
    ).edges.find((e) => e.raw === "clause (z)");
    expect(edge?.status).toBe("unresolved");
    expect(edge?.reason).toBe("no_such_provision");
  });

  it("abstains rather than pick a side when a table of contents duplicates a label", () => {
    const withToc = [
      "TABLE OF CONTENTS",
      "",
      "Section 6.2 Mutual Conditions",
      "",
      AGREEMENT,
    ].join("\n");
    const edge = crossReferenceGraph(withToc, "toc").edges.find(
      (e) => e.raw === "Section 6.2" && e.status !== "resolved",
    );
    expect(edge?.status).toBe("abstained");
    expect(edge?.reason).toBe("ambiguous_label");
  });

  it("abstains for the whole document when most accepted references still miss", () => {
    // Real numbering exists, but the references address a scheme the
    // document does not use; the gate refuses rather than ship bad targets.
    const text = [
      "Section 1.1 Alpha. See Section 1.9, Section 1.8 and Section 1.7.",
      "Section 1.2 Beta. See Section 1.6, Section 1.5 and Section 1.4.",
      "Section 1.3 Gamma. Nothing further.",
    ].join("\n\n");
    const gated = crossReferenceGraph(text, "gate");
    expect(gated.documentAbstained).toBe(true);
    expect(gated.note).toMatch(/numbering scheme/u);
    expect(gated.counts.resolved).toBe(0);

    const ungated = crossReferenceGraph(text, "gate", { integrityThreshold: 0 });
    expect(ungated.documentAbstained).toBe(false);
    expect(ungated.counts.unresolved).toBeGreaterThan(0);
    expect(ungated.counts.integrity).toBeLessThan(0.5);
  });
});

describe("weaker edge classes stay separate", () => {
  it("runs defined-term edges from the USE to the single definition site", () => {
    const skeleton = compileAgreementSkeleton(AGREEMENT, "fixture");
    const edges = definedTermEdges(AGREEMENT, skeleton);
    const fee = edges.find((e) => e.evidence.includes("Termination Fee"));
    expect(fee?.targetLabel).toBe("sec7.3");
    expect(fee?.sourceLabel).toBe("sec1.1");
  });

  it("reads curly-quoted definitions, which the line-based collector alone misses", () => {
    const curly = AGREEMENT.replace(/"Termination Fee"/u, "“Termination Fee”");
    const skeleton = compileAgreementSkeleton(curly, "curly");
    expect(skeleton.definedTerms).toHaveLength(0);
    expect(
      definedTermEdges(curly, skeleton).some((e) =>
        e.evidence.includes("Termination Fee"),
      ),
    ).toBe(true);
  });

  it("keeps lexical edges out of the literal graph entirely", () => {
    const skeleton = compileAgreementSkeleton(AGREEMENT, "fixture");
    const lexical = lexicalOverlapEdges(AGREEMENT, skeleton);
    for (const edge of lexical) expect(edge.evidence).toMatch(/rare tokens/u);
    const graph = graphOf(AGREEMENT);
    expect(graph.edges.every((edge) => !("evidence" in edge))).toBe(true);
  });
});

describe("crossReferenceGraph — the contents-page trap", () => {
  // Acacia Communications' shape: the contents page prints every heading at
  // a line start, the body's headings survive extraction nowhere, and so
  // every reference resolves — to a contents line — and integrity reads 1.00.
  const filler = "The parties agree to the foregoing at length. ".repeat(60);
  const CONTENTS_ONLY = [
    "TABLE OF CONTENTS",
    "1.01 Definitions",
    "2.01 The Merger",
    "3.01 Closing",
    `${filler} as provided in Section 1.01 and Section 2.01.`,
    `${filler} subject to Section 3.01 and Section 2.01.`,
    `${filler} governed by Section 1.01 and Section 3.01.`,
  ].join("\n");

  it("abstains when every resolved target lands in a thin prefix", () => {
    const graph = crossReferenceGraph(CONTENTS_ONLY, "toc-only");
    expect(graph.documentAbstained).toBe(true);
    expect(graph.note).toMatch(/table of contents/u);
    expect(graph.counts.resolved).toBe(0);
  });

  it("says so without the gate, so the refusal is the gate's and not the resolver's", () => {
    const ungated = crossReferenceGraph(CONTENTS_ONLY, "toc-only", {
      integrityThreshold: 0,
    });
    expect(ungated.counts.integrity).toBe(1);
    expect(ungated.counts.resolved).toBeGreaterThan(0);
  });
});
