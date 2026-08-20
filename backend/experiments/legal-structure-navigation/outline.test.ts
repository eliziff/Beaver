import { expect, it } from "vitest";

import { compileAgreementSkeleton } from "../../src/lib/legalTextSkeleton";
import { renderAgreementOutline } from "./outline";

it("preserves every structural handle and marks ambiguous labels", async () => {
  const skeleton = await compileAgreementSkeleton([
    "Section 1.01 Contents entry.",
    "Section 2.01 Another entry.",
    "Section 1.01 Operative provision.",
  ].join("\n"));
  const outline = renderAgreementOutline(skeleton);
  expect(outline).toContain("[repeated sec1.01]");
});
