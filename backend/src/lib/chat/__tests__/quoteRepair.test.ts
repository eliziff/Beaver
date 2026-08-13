import { describe, expect, it } from "vitest";

import { nearestVerbatimExcerpt, quoteRepairSuggestion } from "../quoteRepair";

const passage =
  "If rent is unpaid when due, the landlord may deliver a written notice " +
  "to terminate the lease not less than seven business days after receipt " +
  "of the notice by the tenant.";

describe("quote repair", () => {
  it("returns only a sufficiently strong verbatim window", () => {
    const repair = nearestVerbatimExcerpt(
      "the landlord may deliver a written notice to terminate the lease within seven calendar days",
      passage,
    );
    expect(repair.excerpt).toBe("the landlord may deliver a written notice to terminate the lease");
    expect(repair.matched).toBe(11);
    expect(repair.score).toBeGreaterThan(0.6);
    expect(quoteRepairSuggestion("Municipal recall elections are governed by a comprehensive scheme.", [passage])).toBeNull();
  });
});
