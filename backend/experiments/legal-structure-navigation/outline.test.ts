import { expect, it } from "vitest";

import { compileAgreementSkeleton } from "../../src/lib/legalTextSkeleton";
import { renderAgreementOutline } from "./outline";

it("preserves every structural handle and marks ambiguous labels", () => {
  const skeleton = compileAgreementSkeleton([
    "Section 1.01 Contents entry.",
    "Section 2.01 Another entry.",
    "Section 1.01 Operative provision.",
  ].join("\n"));
  const outline = renderAgreementOutline(skeleton, { toolLabel: undefined });
  expect(outline).toContain("[repeated sec1.01]");
  expect(outline).not.toContain("library_find");
});
