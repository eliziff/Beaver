import { describe, expect, it } from "vitest";

import { conflictScan } from "../legalConflictScan";
import { extractAnchors } from "../legalTextAnchors";

describe("area anchors", () => {
  it("normalizes sqft surface forms to one key", () => {
    const hits = extractAnchors(
      "approximately 45,000 rentable square feet, later stated as 45,000 RSF and 45,000 SF",
    );
    const areas = hits.filter((hit) => hit.cls === "area");
    expect(areas).toHaveLength(3);
    expect(new Set(areas.map((hit) => hit.norm))).toEqual(
      new Set(["area:sqft:45000"]),
    );
  });

  it("keeps unit families apart and reads hyphenated acreage", () => {
    const hits = extractAnchors("a 3.5-acre parcel improved with 1,200 square metres");
    const norms = hits.filter((hit) => hit.cls === "area").map((hit) => hit.norm);
    expect(norms).toEqual(["area:acre:3.5", "area:sqm:1200"]);
  });

  it("does not read prose initials as areas", () => {
    const hits = extractAnchors("the SF office and 12 SF employees of RSF Ltd.");
    expect(hits.filter((hit) => hit.cls === "area")).toHaveLength(1); // only "12 SF"
  });
});

describe("conflictScan", () => {
  it("passes a consistent part-of-whole statement silently", () => {
    const report = conflictScan([
      {
        name: "lease.txt",
        text: "Tenant leases 30,000 SF of the 120,000 SF building (25% of the building).",
      },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(report.consistent).toBe(1);
  });

  it("flags a percent that does not close against its figures", () => {
    const report = conflictScan([
      {
        name: "note.txt",
        text: "Borrower prepaid $300,000 of the $1,000,000 principal, a 25% reduction.",
      },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe("percent_of_whole");
    expect(report.findings[0].implied_percent).toBe(30);
  });

  it("respects stated precision when checking percentages", () => {
    // 81.25% stated as 81.3% is within half a unit of the last place.
    const report = conflictScan([
      {
        name: "roll.txt",
        text: "84,500 SF leased of 104,000 SF (81.3% occupied).",
      },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(report.consistent).toBe(1);
  });

  it("joins an occupancy claim to a leased total stated pages apart", () => {
    const filler = "General provisions. ".repeat(300);
    const report = conflictScan([
      {
        name: "agreement.txt",
        text:
          "The improvements contain 200,000 square feet and are approximately 90% leased. " +
          filler +
          "Total Leased 175,000 SF against Total Building 200,000 SF.",
      },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].implied_percent).toBe(87.5);
    expect(report.findings[0].approximate).toBe(true);
  });

  it("checks subtotals against stated totals", () => {
    const report = conflictScan([
      {
        name: "schedule.txt",
        text:
          "Parcel A Subtotal: $400,000. Parcel B Subtotal: $350,000. " +
          "Aggregate Total: $800,000.",
      },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe("sum_of_parts");
    expect(report.findings[0].parts_sum).toBe(750_000);
  });

  it("abstains when an unaccounted figure sits between the parts and the total", () => {
    const report = conflictScan([
      {
        name: "bid.txt",
        text:
          "Phase One Subtotal: $120,000. Phase Two Subtotal: $80,000. " +
          "Mobilization allowance $45,000. Contract Total: $190,000.",
      },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(report.checks.sum_of_parts).toBe(0);
    expect(
      report.abstentions.find((a) => a.reason === "incomplete_parts_column"),
    ).toBeTruthy();
  });

  it("does not pair figures across a labeled field boundary", () => {
    const report = conflictScan([
      {
        name: "sheet.txt",
        text: "Initial advance: $2,000 Facility of record: $9,000 Stated rate: 5%",
      },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(report.checks.percent_of_whole).toBe(0);
  });

  it("ignores a percent stated too far from the pair it would restate", () => {
    const report = conflictScan([
      {
        name: "note.txt",
        text:
          "The note bears interest at 7% per annum. After a long recital of " +
          "the parties' prior dealings, the borrower repaid $4,000 of the " +
          "$10,000 principal.",
      },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(report.checks.percent_of_whole).toBe(0);
  });

  it("abstains rather than guesses when a claim has nothing to pair with", () => {
    const report = conflictScan([
      { name: "memo.txt", text: "The property is approximately 90% leased." },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(
      report.abstentions.find((a) => a.reason === "unjoined_percent_claim"),
    ).toBeTruthy();
  });
});
