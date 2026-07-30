import { describe, expect, it } from "vitest";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  deterministicClaimSupport,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
} from "../legalEvidenceExperiment";
import {
  nearestVerbatimExcerpt,
  quoteRepairSuggestion,
} from "../quoteRepair";

const passage =
  "If rent is unpaid when due, the landlord may deliver a written notice " +
  "to terminate the lease not less than seven business days after receipt " +
  "of the notice by the tenant.";

describe("quote repair (ALR diff-machinery port)", () => {
  it("finds the span's own contiguous window behind a near-miss quote", () => {
    const repair = nearestVerbatimExcerpt(
      "the landlord may deliver a written notice to terminate the lease " +
        "within seven calendar days",
      passage,
    );
    expect(repair.excerpt).toBe(
      "the landlord may deliver a written notice to terminate the lease",
    );
    expect(repair.matched).toBe(11);
    expect(repair.score).toBeGreaterThan(0.6);
  });

  it("refuses to suggest from thin overlap", () => {
    expect(
      quoteRepairSuggestion(
        "Municipal recall elections are governed by a comprehensive scheme.",
        [passage],
      ),
    ).toBeNull();
    expect(nearestVerbatimExcerpt("seven business days", passage).excerpt)
      .toBeNull();
  });

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
