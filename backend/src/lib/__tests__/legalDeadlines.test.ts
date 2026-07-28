import { describe, expect, it } from "vitest";

import {
  computeDeadline,
  durationNormToUnit,
  holidaysFor,
  isBusinessDay,
} from "../legalDeadlines";

describe("holidaysFor", () => {
  it("computes movable feasts from the statutory formulas", () => {
    const ca2026 = holidaysFor(2026, "CA");
    expect(ca2026.get("2026-04-03")).toBe("Good Friday"); // Easter 2026-04-05
    expect(ca2026.get("2026-04-06")).toBe("Easter Monday");
    expect(ca2026.get("2026-05-18")).toBe("Victoria Day"); // Monday before May 25
    expect(ca2026.get("2026-09-07")).toBe("Labour Day");
    expect(ca2026.get("2026-10-12")).toBe("Thanksgiving");
    expect(ca2026.get("2026-09-30")).toBe(
      "National Day for Truth and Reconciliation",
    );
  });

  it("differs by jurisdiction where the statutes differ", () => {
    expect(holidaysFor(2026, "CA-ON").get("2026-02-16")).toBe("Family Day");
    expect(holidaysFor(2026, "CA").get("2026-02-16")).toBeUndefined();
    expect(holidaysFor(2026, "CA-QC").get("2026-06-24")).toContain(
      "Saint-Jean-Baptiste",
    );
    expect(holidaysFor(2026, "CA-BC").get("2026-08-03")).toBe(
      "British Columbia Day",
    );
    // Easter Monday is federal but not a BC statutory holiday.
    expect(holidaysFor(2026, "CA-BC").get("2026-04-06")).toBeUndefined();
    expect(holidaysFor(2026, "CA-BC").get("2026-04-03")).toBe("Good Friday");
  });

  it("shifts observed US federal holidays across weekends", () => {
    const us2026 = holidaysFor(2026, "US");
    expect(us2026.get("2026-07-04")).toBe("Independence Day"); // Saturday
    expect(us2026.get("2026-07-03")).toBe("Independence Day (observed)");
    expect(us2026.get("2026-05-25")).toBe("Memorial Day");
  });
});

describe("computeDeadline: day counting", () => {
  it("excludes the anchor day and includes the last (s. 27(2))", () => {
    const result = computeDeadline({
      anchor: "2026-07-28",
      count: 10,
      unit: "day",
      jurisdiction: "CA",
    });
    expect(result.date).toBe("2026-08-07");
    expect(result.trace.some((step) => step.rule.includes("27(2)"))).toBe(true);
  });

  it("rolls a deadline off a holiday with the holiday named (s. 26)", () => {
    // 5 days after 2026-06-26 lands on Canada Day.
    const result = computeDeadline({
      anchor: "2026-06-26",
      count: 5,
      unit: "day",
      jurisdiction: "CA",
    });
    expect(result.date).toBe("2026-07-02");
    const rollover = result.trace.find((step) => step.rule.includes("s. 26"));
    expect(rollover?.note).toContain("Canada Day");
  });

  it("keeps rolling across consecutive non-working days", () => {
    // 2 days after Thu 2026-12-23 → Fri Dec 25 (Christmas) → Sat 26
    // (Boxing Day + weekend) → Sun 27 → Mon 28.
    const result = computeDeadline({
      anchor: "2026-12-23",
      count: 2,
      unit: "day",
      jurisdiction: "CA-ON",
    });
    expect(result.date).toBe("2026-12-28");
  });

  it("computes clear days by excluding both terminal days (s. 27(1))", () => {
    // 15 − (7+1) = Sep 7, which is Labour Day; a before-direction deadline
    // rolls EARLIER (acting the next day would shrink the clear period),
    // across the weekend to Friday Sep 4.
    const result = computeDeadline({
      anchor: "2026-09-15",
      count: 7,
      unit: "clear_day",
      direction: "before",
      jurisdiction: "CA",
    });
    expect(result.date).toBe("2026-09-04");
    expect(
      result.trace.some((step) => step.note.includes("Labour Day")),
    ).toBe(true);
  });
});

describe("computeDeadline: business days", () => {
  it("skips weekends and holidays, tracing each skip", () => {
    const result = computeDeadline({
      anchor: "2025-12-19", // Friday
      count: 5,
      unit: "business_day",
      jurisdiction: "CA-ON",
    });
    expect(result.date).toBe("2025-12-30");
    const skipped = result.trace.filter((step) => step.note.includes("skipped"));
    expect(skipped.some((step) => step.note.includes("Christmas Day"))).toBe(true);
    expect(skipped.some((step) => step.note.includes("Boxing Day"))).toBe(true);
  });

  it("honours contract-designated extra non-business days", () => {
    const result = computeDeadline({
      anchor: "2026-07-27",
      count: 2,
      unit: "business_day",
      jurisdiction: "CA",
      extraHolidays: ["2026-07-28"],
    });
    expect(result.date).toBe("2026-07-30");
    expect(
      result.trace.some((step) => step.note.includes("contract-designated")),
    ).toBe(true);
  });
});

describe("computeDeadline: months and years (s. 28)", () => {
  it("uses the anniversary day and clamps to month end", () => {
    expect(
      computeDeadline({ anchor: "2026-11-30", count: 3, unit: "month", rollover: false }).date,
    ).toBe("2027-02-28");
    expect(
      computeDeadline({ anchor: "2024-01-31", count: 1, unit: "month", rollover: false }).date,
    ).toBe("2024-02-29");
  });

  it("clamps leap-day anniversaries", () => {
    expect(
      computeDeadline({ anchor: "2024-02-29", count: 2, unit: "year", rollover: false }).date,
    ).toBe("2026-02-28");
  });

  it("counts months backward", () => {
    expect(
      computeDeadline({
        anchor: "2026-03-31",
        count: 1,
        unit: "month",
        direction: "before",
        rollover: false,
      }).date,
    ).toBe("2026-02-28");
  });
});

describe("bridges", () => {
  it("converts anchor duration norms into engine parameters", () => {
    expect(durationNormToUnit("dur:5:business_day")).toEqual({
      count: 5,
      unit: "business_day",
    });
    expect(durationNormToUnit("dur:30:day")).toEqual({ count: 30, unit: "day" });
    expect(durationNormToUnit("pct:50")).toBeNull();
  });

  it("answers isBusinessDay with jurisdiction awareness", () => {
    expect(isBusinessDay("2026-02-16", { jurisdiction: "CA-ON" })).toBe(false);
    expect(isBusinessDay("2026-02-16", { jurisdiction: "CA" })).toBe(true);
    expect(isBusinessDay("2026-07-25", { jurisdiction: "CA" })).toBe(false); // Saturday
    expect(
      isBusinessDay("2026-07-25", { jurisdiction: "CA", weekend: "sun_only" }),
    ).toBe(true);
  });
});
