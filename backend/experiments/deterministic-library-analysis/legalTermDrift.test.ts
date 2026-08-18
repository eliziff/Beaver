import { describe, expect, it } from "vitest";

import { termDriftReport } from "./legalTermDrift";

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

  it("keeps cross-reference bodies out of the divergence comparison", () => {
    const pointer = {
      name: "p.txt",
      text: '"Reference Rate" has the meaning assigned thereto in Section 9.1.',
    };
    const tuesday = {
      name: "a.txt",
      text: '"Reference Rate" means the rate published each Tuesday by the Registrar.',
    };
    const thursday = {
      name: "b.txt",
      text: '"Reference Rate" means the rate published each Thursday by the Registrar.',
    };
    const report = termDriftReport([pointer, tuesday, thursday]);
    const row = report.shared.find((r) => r.term === "Reference Rate");
    expect(row?.status).toBe("divergent");
    expect(row?.divergence?.documents).toEqual(["a.txt", "b.txt"]);
    expect(row?.definitions.find((d) => d.document === "p.txt")?.isPointer).toBe(
      true,
    );
  });

  it("reports no row when every definition of a term is a cross-reference", () => {
    const report = termDriftReport([
      { name: "p.txt", text: '"Reference Rate" has the meaning set forth in Section 4.2.' },
      { name: "q.txt", text: '"Reference Rate" shall have the meaning given to it in Schedule B.' },
    ]);
    expect(report.shared.find((r) => r.term === "Reference Rate")).toBeUndefined();
  });

  it("treats a body cut before its list as truncation, not drift", () => {
    const stem = {
      name: "stem.txt",
      text: '"Excluded Asset" means each of the following:\n\n(a) the Norwood parcel.',
    };
    const full = {
      name: "full.txt",
      text:
        '"Excluded Asset" means each of the following: (a) the Norwood parcel, ' +
        "and (b) the Kestrel licence.",
    };
    const report = termDriftReport([stem, full]);
    expect(report.shared.find((r) => r.term === "Excluded Asset")?.status).toBe(
      "consistent",
    );
  });

  it("still flags a shorter body that closed its own sentence", () => {
    const short = { name: "s.txt", text: '"Cure Period" means ten Business Days.' };
    const long = {
      name: "l.txt",
      text: '"Cure Period" means ten Business Days, extended by any Standstill Period.',
    };
    const report = termDriftReport([short, long]);
    expect(report.shared.find((r) => r.term === "Cure Period")?.status).toBe(
      "divergent",
    );
  });

  it("suppresses imported uses in a document that expressly incorporates definitions", () => {
    const master = {
      name: "master.txt",
      text: '"Collateral Pool" means the assets pledged under Schedule 2.',
    };
    const cert = {
      name: "cert.txt",
      text:
        "Unless otherwise defined herein, capitalized terms used in this " +
        "certificate shall have the meanings assigned to such terms in the " +
        "Master Agreement. The Collateral Pool remains unencumbered.",
    };
    const plain = {
      name: "plain.txt",
      text: "The Collateral Pool remains unencumbered.",
    };
    const suppressed = termDriftReport([master, cert]);
    expect(suppressed.importedUses).toHaveLength(0);
    expect(suppressed.suppressedImportedUses).toBe(1);

    const reported = termDriftReport([master, plain]);
    expect(reported.importedUses[0]?.usedIn).toBe("plain.txt");
    expect(reported.suppressedImportedUses).toBe(0);
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
