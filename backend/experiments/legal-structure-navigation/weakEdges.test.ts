import { describe, expect, it } from "vitest";

import { compileAgreementSkeleton } from "../../src/lib/legalTextSkeleton";
import { crossReferenceGraph } from "../../src/lib/legalCrossReference";
import { definedTermEdges, lexicalOverlapEdges } from "./weakEdges";

const AGREEMENT = [
  "ARTICLE I DEFINITIONS",
  "Section 1.1 Definitions. The Termination Fee is payable under Section 7.3.",
  "ARTICLE VI CONDITIONS",
  "Section 6.1 Conditions. The obligations are subject to Section 6.2.",
  "Section 6.2 Mutual Conditions. The approvals and termination conditions apply.",
  "ARTICLE VII TERMINATION",
  'Section 7.3 Termination Fee. The Company shall pay a fee (the “Termination Fee”) under the termination conditions.',
].join("\n\n");

describe("experimental weak edges", () => {
  it("points a unique defined-term use to its definition", async () => {
    const skeleton = await compileAgreementSkeleton(AGREEMENT, "fixture");
    expect(
      definedTermEdges(AGREEMENT, skeleton).find((edge) =>
        edge.evidence.includes("Termination Fee"),
      ),
    ).toMatchObject({ sourceLabel: "sec1.1", targetLabel: "sec7.3" });
  });

  it("never contaminates the literal graph with inferred evidence", async () => {
    const skeleton = await compileAgreementSkeleton(AGREEMENT, "fixture");
    expect(lexicalOverlapEdges(AGREEMENT, skeleton).every((edge) => edge.evidence.length > 0))
      .toBe(true);
    expect(
      (await crossReferenceGraph(AGREEMENT, "fixture", { skeleton })).edges.every(
        (edge) => !("evidence" in edge),
      ),
    ).toBe(true);
  });
});
