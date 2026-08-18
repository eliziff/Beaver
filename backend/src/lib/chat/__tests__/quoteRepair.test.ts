import { describe, expect, it } from "vitest";

import {
  groundedProseIntegrityErrors,
  nearestVerbatimExcerpt,
  quoteRepairSuggestion,
  sourceSupportsMarkedQuote,
} from "../quoteRepair";

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

  it("accepts only representation changes or visibly marked monotonic edits", () => {
    const source = "The busybody must decide 12 motions, promptly, before the hearing continues.";
    expect(sourceSupportsMarkedQuote(
      "The\u00a0busybody must decide 12 motions, promptly, before the hearing continues.",
      source,
    )).toBe(true);
    expect(sourceSupportsMarkedQuote(
      'The court called it "unusual".',
      "The court called it \u201cunusual\u201d.",
    )).toBe(true);
    expect(sourceSupportsMarkedQuote(
      "[T]he busybod[ies] must decide 12 motions, promptly, before the hearing continues.",
      source,
    )).toBe(true);
    expect(sourceSupportsMarkedQuote(
      "The busybody … before the hearing continues.",
      source,
    )).toBe(true);
    for (const changed of [
      "the busybody must decide 12 motions, promptly, before the hearing continues.",
      "The busybody may decide 12 motions, promptly, before the hearing continues.",
      "The busybody must decide 13 motions, promptly, before the hearing continues.",
      "The busybody must decide 12 motions promptly before the hearing continues.",
    ]) expect(sourceSupportsMarkedQuote(changed, source)).toBe(false);
  });

  it("rejects substantial unmarked copying from any visible receipt", () => {
    const copied = "Courts should not decide constitutional issues in a factual vacuum without evidence.";
    const sources = [
      { evidenceId: "e_cited", text: passage },
      { evidenceId: "e_visible", text: copied },
    ];
    expect(groundedProseIntegrityErrors(copied, ["e_cited"], sources)[0])
      .toContain("visible evidence e_visible");
    expect(groundedProseIntegrityErrors(`The court said “${copied}”`, ["e_visible"], sources))
      .toEqual([]);
    expect(groundedProseIntegrityErrors(`> ${copied}`, ["e_visible"], sources))
      .toEqual([]);
    expect(groundedProseIntegrityErrors(
      "Courts should not decide constitutional issues automatically.",
      ["e_cited"],
      sources,
    )).toEqual([]);
    const title = "A Treatise About Constitutional Standing and Legal Remedies";
    expect(groundedProseIntegrityErrors(title, ["e_cited"], [{
      evidenceId: "e_cited",
      text: `${title}. Further discussion follows.`,
      labels: [title],
    }])).toEqual([]);
  });
});
