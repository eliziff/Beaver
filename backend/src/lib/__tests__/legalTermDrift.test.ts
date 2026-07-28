import { describe, expect, it } from "vitest";

import { termDriftReport } from "../legalTermDrift";

const CREDIT = {
  name: "credit-agreement.txt",
  text: [
    "ARTICLE I",
    "DEFINITIONS",
    "",
    "Section 1.01 Defined Terms.",
    "",
    "“Business Day” means any day other than a Saturday, Sunday or day on " +
      "which banks in Toronto are authorized to close.",
    "",
    "“Material Adverse Effect” means a material adverse effect on the " +
      "business, assets or condition of the Borrower.",
    "",
    "Section 1.02 Other Terms. The Guarantor shall confirm each Draw " +
      "Notice before any advance.",
  ].join("\n"),
};

const GUARANTEE = {
  name: "guarantee.txt",
  text: [
    "1. Definitions.",
    "",
    "“Business Day” means any day other than a Saturday, Sunday or day on " +
      "which banks in Toronto or New York are authorized to close.",
    "",
    "“Material Adverse Effect” means a material adverse effect on the " +
      "business, assets or condition of the Borrower.",
  ].join("\n"),
};

describe("termDriftReport", () => {
  it("flags divergent shared definitions with a located first difference", () => {
    const report = termDriftReport([CREDIT, GUARANTEE]);
    const businessDay = report.shared.find((row) => row.term === "Business Day");
    expect(businessDay?.status).toBe("divergent");
    expect(businessDay?.divergence?.documents).toEqual([
      "credit-agreement.txt",
      "guarantee.txt",
    ]);
    expect(businessDay?.divergence?.excerpts[1]).toContain("or New York");
    // Divergent rows sort first.
    expect(report.shared[0].term).toBe("Business Day");
  });

  it("reports identical shared definitions as consistent across glyphs", () => {
    const straightQuotes = {
      name: "b.txt",
      text:
        '"Material Adverse Effect" means a material adverse effect on the ' +
        "business,  assets or condition of the Borrower.",
    };
    const report = termDriftReport([CREDIT, straightQuotes]);
    const mae = report.shared.find((row) => row.term === "Material Adverse Effect");
    expect(mae?.status).toBe("consistent");
  });

  it("anchors definitions to skeleton section labels", () => {
    const report = termDriftReport([CREDIT, GUARANTEE]);
    const mae = report.shared.find((row) => row.term === "Material Adverse Effect");
    expect(mae?.definitions[0].sectionLabel).toBe("sec1.01");
  });

  it("surfaces terms used in a document that defines them nowhere", () => {
    const notice = {
      name: "notice.txt",
      text:
        "“Draw Notice” means a notice of borrowing delivered under the " +
        "Credit Agreement.",
    };
    const report = termDriftReport([CREDIT, notice]);
    const gap = report.importedUses.find(
      (row) => row.term === "Draw Notice" && row.usedIn === "credit-agreement.txt",
    );
    expect(gap).toBeDefined();
    expect(gap?.definedIn).toEqual(["notice.txt"]);
    expect(gap?.occurrences).toBe(1);
  });

  it("counts in-document duplicate definitions instead of dropping them", () => {
    const doubled = {
      name: "d.txt",
      text:
        "“Business Day” means one thing.\n\n" +
        "“Business Day” means another thing entirely.",
    };
    const report = termDriftReport([doubled, GUARANTEE]);
    const row = report.shared.find((r) => r.term === "Business Day");
    expect(row?.definitions.find((d) => d.document === "d.txt")?.duplicatesInDocument).toBe(1);
  });
});
