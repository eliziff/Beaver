/**
 * Tests for legalDeadlineOmissionScan — the deadline working-back omission
 * organ. Fixtures are representative real legal sentences (notice clauses,
 * consent windows, option deadlines, filing deadlines), not benchmark text.
 */
import { describe, expect, it } from "vitest";
import {
  deadlineOmissionScan,
  type DeadlineDocument,
} from "../legalDeadlineOmissionScan";

const scan = (source: string, draft: string) =>
  deadlineOmissionScan(
    [{ name: "agreement.txt", text: source }],
    { name: "draft.txt", text: draft },
  );

// The consent-window relationship: consent request due 60 days before the
// October 15, 2027 closing → resolved deadline 2027-08-16.
const CONSENT_SOURCE =
  "The Company shall deliver its consent request not later than sixty (60) days " +
  "prior to the Closing Date (October 15, 2027).";

describe("legalDeadlineOmissionScan", () => {
  it("stays silent when the resolved date is carried", () => {
    const report = scan(
      CONSENT_SOURCE,
      "Consent must be delivered by August 16, 2027.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.resolved).toBe(1);
    expect(report.engaged).toBe(1);
  });

  it("fires when the anchor date is engaged but the resolved date is omitted", () => {
    const report = scan(
      CONSENT_SOURCE,
      "The consent request must be delivered before the October 15, 2027 closing.",
    );
    expect(report.findings).toHaveLength(1);
    const [f] = report.findings;
    expect(f.kind).toBe("deadline_omission");
    expect(f.engaged).toContain("anchor");
    expect(f.engaged).not.toContain("duration");
    expect(f.resolved).toBe("2027-08-16");
    expect(f.detail).toContain("2027-10-15 − 60 days = 2027-08-16");
    expect(f.detail).toContain("consent request");
    expect(f.anchor.display).toBe("October 15, 2027");
    expect(f.duration.value).toBe("dur:60:day");
  });

  it("fires when the duration is engaged but the resolved date is omitted", () => {
    const report = scan(
      CONSENT_SOURCE,
      "Consent must be delivered 60 days before closing.",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].engaged).toContain("duration");
    expect(report.findings[0].resolved).toBe("2027-08-16");
  });

  it("fires on trigger-only engagement (no anchor or duration carried)", () => {
    const report = scan(CONSENT_SOURCE, "The consent request was uncontested.");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].engaged).toEqual(["trigger"]);
    expect(report.findings[0].resolved).toBe("2027-08-16");
  });

  it("stays silent when neither side is engaged (coverage gap, not carry-through)", () => {
    const report = scan(
      CONSENT_SOURCE,
      "The transaction is expected to close in the first quarter of 2028.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.engaged).toBe(0);
  });

  it("carries the resolved date within ±1 day silently (boundary)", () => {
    const report = scan(
      CONSENT_SOURCE,
      "Consent must be delivered by August 17, 2027.",
    );
    expect(report.findings).toHaveLength(0);
  });

  it("refuses a business-day period instead of approximating calendar days", () => {
    const report = scan(
      "Each invoice shall be settled within ten (10) business days after the " +
        "Delivery Date (June 2, 2033).",
      "Invoices settle within 10 business days of delivery.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.resolved).toBe(0);
    expect(report.refusals).toEqual([
      expect.objectContaining({ reason: "calendar_dependent", count: 1 }),
    ]);
  });

  it("refuses 'within N days of receipt' with no stated calendar anchor", () => {
    const report = scan(
      "The Company shall deliver the certificate within thirty (30) days of receipt " +
        "of the request.",
      "The certificate is delivered within 30 days.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.resolved).toBe(0);
    expect(report.refusals).toEqual([
      expect.objectContaining({ reason: "unstated_anchor", count: 1 }),
    ]);
  });

  it("refuses when the first following date is itself a restated deadline", () => {
    const report = scan(
      "The Buyer shall complete diligence within forty-five (45) days after the " +
        "Effective Date, i.e., on or before November 21, 2024.",
      "Diligence runs 45 days from the Effective Date.",
    );
    expect(report.findings).toHaveLength(0);
    expect(report.resolved).toBe(0);
    expect(report.refusals).toEqual([
      expect.objectContaining({ reason: "ambiguous_base", count: 1 }),
    ]);
  });

  it("resolves plain calendar units (120 days prior to a lease expiration)", () => {
    const report = scan(
      "The filing shall be made not later than one hundred twenty (120) days prior " +
        "to the Lease Expiration Date (March 31, 2028).",
      "The filing must be made in advance of the March 31, 2028 lease expiration.",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].resolved).toBe("2027-12-02");
    expect(report.findings[0].detail).toContain("2028-03-31 − 120 days = 2027-12-02");
  });

  it("clamps month arithmetic to the end of the target month", () => {
    const report = scan(
      "The option expires one (1) month after the Grant Date (January 31, 2034).",
      "The option is tied to the January 31, 2034 grant.",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].resolved).toBe("2034-02-28");
  });

  it("treats a within-bound ('following') relationship as a resolvable deadline", () => {
    const report = scan(
      "The Buyer may require the Company to repurchase the Shares no later than " +
        "thirty (30) days following the Change of Control (February 1, 2028).",
      "The repurchase right arises on the February 1, 2028 change of control.",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].resolved).toBe("2028-03-02");
    expect(report.findings[0].detail).toContain("2028-02-01 + 30 days = 2028-03-02");
  });

  it("dedupes the same relationship stated twice (prose + restatement)", () => {
    const source =
      CONSENT_SOURCE +
      " The Closing Date is October 15, 2027 and consent is due sixty (60) days " +
      "before it.";
    const report = scan(source, "The consent request relates to the October 15, 2027 closing.");
    expect(report.findings).toHaveLength(1);
    expect(report.resolved).toBe(1);
  });

  it("stays silent when the draft carries the full identity (anchor + duration + date)", () => {
    const report = scan(
      CONSENT_SOURCE,
      "Consent is due 60 days before the October 15, 2027 closing, i.e., by August 16, 2027.",
    );
    expect(report.findings).toHaveLength(0);
  });

  it("does not treat a nearby unrelated date as the anchor", () => {
    // The base the idiom attaches to is the grant date, not the later deadline.
    const report = scan(
      "The Agreement is dated March 2, 2036. Notice of termination shall be given " +
        "sixty (60) days after the Renewal Date (July 15, 2029).",
      "The agreement is dated March 2, 2036.",
    );
    // "March 2, 2036" precedes the period, so it is not the base; the draft
    // carries only an unrelated date, so nothing fires.
    expect(report.findings).toHaveLength(0);
    expect(report.resolved).toBe(1);
    expect(report.engaged).toBe(0);
  });
});
