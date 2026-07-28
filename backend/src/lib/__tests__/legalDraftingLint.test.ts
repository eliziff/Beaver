import { describe, expect, it } from "vitest";

import { draftingLint } from "../legalDraftingLint";

describe("draftingLint", () => {
  it("flags may-not as ambiguous without offering a blind autofix", () => {
    const report = draftingLint(
      "The tenant may not assign this lease without consent.",
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      rule: "may-not-prohibition",
      severity: "warning",
      match: "may not",
    });
    expect(report.findings[0].autofix).toBeUndefined();
    expect(report.findings[0].excerpt).toContain("assign this lease");
  });

  it("flags and/or and stacked modals with exact spans", () => {
    const text =
      "The vendor and/or its agents shall may deliver the goods.";
    const report = draftingLint(text);
    expect(report.counts["and-or"]).toBe(1);
    expect(report.counts["stacked-modals"]).toBe(1);
    const stacked = report.findings.find((f) => f.rule === "stacked-modals");
    expect(stacked?.severity).toBe("error");
    expect(text.slice(stacked!.index, stacked!.index + stacked!.match.length)).toBe(
      "shall may",
    );
  });

  it("reports mixed shall/must once, at the minority form", () => {
    const report = draftingLint(
      "The buyer shall pay the price. The seller shall deliver. " +
        "The broker must disclose its commission.",
    );
    const mixed = report.findings.filter((f) => f.rule === "mixed-shall-must");
    expect(mixed).toHaveLength(1);
    expect(mixed[0].match).toBe("must");
    expect(report.modalProfile.shall).toBe(2);
    expect(report.modalProfile.must).toBe(1);
  });

  it("does not treat must-not prohibitions as obligation-register drift", () => {
    const report = draftingLint(
      "The licensee shall keep records. The licensee must not sublicense.",
    );
    expect(report.findings.filter((f) => f.rule === "mixed-shall-must")).toEqual([]);
    expect(report.modalProfile["must not"]).toBe(1);
  });

  it("stays silent on clean single-register drafting", () => {
    const report = draftingLint(
      "The supplier must deliver by March 1. The buyer must pay within " +
        "30 days. Either party may terminate for material breach.",
    );
    expect(report.findings).toEqual([]);
    expect(report.modalProfile.must).toBe(2);
  });
});
