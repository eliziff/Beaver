import { describe, expect, it } from "vitest";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  deterministicClaimSupport,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
} from "./legalEvidenceExperiment";

const passage =
  "If rent is unpaid when due, the landlord may deliver a written notice " +
  "to terminate the lease not less than seven business days after receipt " +
  "of the notice by the tenant.";

describe("quote repair", () => {
  it("suggested excerpts are verbatim by construction and clear the tier", () => {
    const state = createLegalEvidenceTurnState("quote_first");
    const receipt = createBenchmarkEvidence({
      stableSourceId: "test:repair",
      sourceText: passage,
      spanText: passage,
      citation: "ALA. CODE § 35-9A-421(b)",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "ALA. CODE § 35-9A-421(b)",
      jurisdiction: "US",
      sourceClass: "legislation",
    });
    registerLegalEvidence(state, receipt);
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text:
              "The landlord may deliver a written notice to terminate the " +
              "lease within seven calendar days after receipt.",
            evidence_ids: [receipt.evidence_id],
            kind: "quotation",
          },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    const hint = result.errors?.[0] ?? "";
    expect(hint).toContain("closest verbatim excerpt");
    const suggested = hint.match(/“([^”]+)”/)?.[1];
    expect(suggested).toBeTruthy();
    expect(
      deterministicClaimSupport(
        { text: `“${suggested}”`, evidence_ids: [receipt.evidence_id] },
        state,
      ),
    ).toBe(true);
  });
});
