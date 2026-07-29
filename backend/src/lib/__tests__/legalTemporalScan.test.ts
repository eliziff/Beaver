import { describe, expect, it } from "vitest";

import { temporalScan } from "../legalTemporalScan";

const scan = (text: string) => temporalScan([{ name: "agreement.txt", text }]);

describe("temporalScan", () => {
  it("passes a consistent equality triple silently", () => {
    const report = scan(
      "The Contractor shall deliver the final report on the date that is thirty (30) days " +
        "after the Commencement Date (March 4, 2031), being April 3, 2031.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.consistent).toBe(1);
    expect(report.checks.date_arithmetic).toBe(1);
    expect(report.abstentions).toHaveLength(0);
    expect(report.anchors_examined).toBe(3);
  });

  it("flags a resolved date that misses the stated period", () => {
    const report = scan(
      "Notice of termination shall be given sixty (60) days after the Renewal Date " +
        "(July 15, 2029), i.e., September 12, 2029.",
    );
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.kind).toBe("date_arithmetic");
    expect(finding.relation).toBe("exact");
    expect(finding.direction).toBe("after");
    expect(finding.computed).toBe("2029-09-13");
    expect(finding.delta_days).toBe(-1);
    expect(finding.detail).toContain("2029-07-15 + 60 days = 2029-09-13");
    expect(finding.detail).toContain("2029-09-12 stated");
    expect(finding.base.display).toBe("July 15, 2029");
    expect(finding.duration.value).toBe("dur:60:day");
    expect(finding.stated.excerpt).toContain("September 12, 2029");
    expect(report.consistent).toBe(0);
  });

  it("treats a date inside a within-bound as consistent", () => {
    const report = scan(
      "The deposit shall be paid within forty-five (45) days after the Effective Date " +
        "(January 10, 2032), i.e., on or before February 20, 2032.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.consistent).toBe(1);
    expect(report.checks.date_arithmetic).toBe(1);
  });

  it("flags a date past the within-bound", () => {
    const report = scan(
      "The deposit shall be paid within forty-five (45) days after the Effective Date " +
        "(January 10, 2032), i.e., on or before March 5, 2032.",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].relation).toBe("bound");
    expect(report.findings[0].computed).toBe("2032-02-24");
    expect(report.findings[0].delta_days).toBe(10);
    expect(report.findings[0].detail).toContain("2032-01-10 + 45 days = 2032-02-24");
  });

  it("abstains on business-day periods instead of counting calendar days", () => {
    const report = scan(
      "Each invoice shall be settled within ten (10) business days after the Delivery Date " +
        "(June 2, 2033), i.e., on or before June 16, 2033.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checks.date_arithmetic).toBe(0);
    expect(report.consistent).toBe(0);
    expect(report.abstentions).toEqual([
      expect.objectContaining({ reason: "calendar_dependent", count: 1 }),
    ]);
  });

  it("clamps month arithmetic to the end of the target month", () => {
    const consistent = scan(
      "The option expires one (1) month after the Grant Date (January 31, 2034), " +
        "being February 28, 2034.",
    );
    expect(consistent.findings).toHaveLength(0);
    expect(consistent.consistent).toBe(1);

    const naive = scan(
      "The option expires one (1) month after the Grant Date (January 31, 2034), " +
        "being March 3, 2034.",
    );
    expect(naive.findings).toHaveLength(1);
    expect(naive.findings[0].computed).toBe("2034-02-28");
    expect(naive.findings[0].detail).toContain("2034-01-31 + 1 month = 2034-02-28");
  });

  it("subtracts when the idiom points backwards", () => {
    const report = scan(
      "The Notice must be given fourteen (14) days prior to the Meeting Date (May 6, 2035), " +
        "being April 22, 2035.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.consistent).toBe(1);

    const mismatch = scan(
      "The Notice must be given ten (10) days before the Closing Date (August 20, 2035), " +
        "that is, August 12, 2035.",
    );
    expect(mismatch.findings).toHaveLength(1);
    expect(mismatch.findings[0].direction).toBe("before");
    expect(mismatch.findings[0].computed).toBe("2035-08-10");
    expect(mismatch.findings[0].detail).toContain("2035-08-20 − 10 days = 2035-08-10");
  });

  it("checks nothing when no direction idiom joins the period to a date", () => {
    const report = scan(
      "The Agreement is dated March 2, 2036. The Contractor shall mobilize within twenty (20) days. " +
        "Substantial completion is targeted for March 22, 2036.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checks.date_arithmetic).toBe(0);
    expect(report.consistent).toBe(0);
    expect(report.abstentions).toHaveLength(0);
  });

  it("abstains when the base date cannot be told from the resolved date", () => {
    const report = scan(
      "This Agreement is dated November 1, 2024. The Buyer shall complete diligence within " +
        "forty-five (45) days after the Effective Date, i.e., on or before November 21, 2024.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checks.date_arithmetic).toBe(0);
    expect(report.abstentions).toEqual([
      expect.objectContaining({ reason: "ambiguous_base", count: 1 }),
    ]);
  });

  it("counts a worded-and-numeral period restatement once", () => {
    const report = scan(
      "Closing shall occur sixty days (60 days) after the Signing Date (March 1, 2037), " +
        "being April 30, 2037.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checks.date_arithmetic).toBe(1);
    expect(report.consistent).toBe(1);
  });
});

describe("temporal refs as citable spans", () => {
  const notice = [
    "ARTICLE II",
    "Term",
    "",
    "2.3 Termination Notice. Notice of termination shall be given sixty (60) " +
      "days after the Renewal Date (July 15, 2029), i.e., September 12, 2029.",
  ].join("\n");

  it("carries the enclosing section handle and each span's offset", () => {
    const [finding] = temporalScan([{ name: "notice.txt", text: notice }])
      .findings;
    // Deepest enclosing node wins: the section, not ARTICLE II.
    expect(finding.base.section).toBe("sec2.3");
    expect(finding.duration.section).toBe("sec2.3");
    expect(finding.stated.section).toBe("sec2.3");
    expect(
      notice.slice(
        finding.stated.at,
        finding.stated.at + finding.stated.display.length,
      ),
    ).toBe("September 12, 2029");
    // The excerpt is ellipsized, so it does not vouch for itself.
    expect(finding.stated.excerpt).toContain("…");
    expect(finding.stated.verbatim).toBe(false);
  });

  it("reports a null section in unsectioned text, and vouches for an uncut excerpt", () => {
    const text =
      "Notice of termination shall be given sixty (60) days after the Renewal " +
      "Date (July 15, 2029), i.e., September 12, 2029.";
    const [finding] = scan(text).findings;
    expect(finding.stated.section).toBeNull();
    expect(finding.duration.section).toBeNull();
    // The duration's window reaches both ends of the passage; the stated
    // date's does not, so only the former is quotable as it stands.
    expect(finding.duration.excerpt).toBe(text);
    expect(finding.duration.verbatim).toBe(true);
    expect(finding.stated.excerpt).toContain("…");
    expect(finding.stated.verbatim).toBe(false);
  });
});
