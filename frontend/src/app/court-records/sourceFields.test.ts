import { describe, expect, it } from "vitest";
import { affidavitSourceFields } from "./sourceFields";

describe("affidavit source fields", () => {
  it("recovers the affidavit cover, parties, jurat, and referenced exhibit slots", () => {
    expect(affidavitSourceFields([
      ["Court File No. 2401-12345", "CALGARY JUDICIAL CENTRE", "COURT OF KING'S BENCH OF ALBERTA",
        "Plaintiff: ALPHA PERSON", "Defendant: BETA PERSON", "Affidavit #7 of SAMPLE DEPONENT"].join("\n"),
      "The January order is attached as Exhibit A. This is Exhibit B referred to in the Affidavit.",
      "SWORN BEFORE ME at Calgary, Alberta this 2nd day of January 2026",
    ])).toEqual({
      cover: {
        courtName: "Court of King's Bench of Alberta",
        courtFileNumber: "2401-12345",
        registry: "Calgary",
        affidavitNumber: "7",
        deponent: "Sample Deponent",
        swornDate: "January 2, 2026",
        swornPlace: "Calgary, Alberta",
      },
      partyStyleId: "action",
      parties: { first: "Alpha Person", second: "Beta Person" },
      exhibitLabels: ["A"],
      explicitExhibitLabel: "B",
      entryTitle: "Affidavit of Sample Deponent",
      entryDate: "January 2, 2026",
    });
  });

  it("reads bare party roles from the preceding line", () => {
    const fields = affidavitSourceFields([["ACME LTD.", "PLAINTIFF", "RIVERSTONE INC.",
      "DEFENDANT", "2nd Affidavit of JANE DOE"].join("\n")]);
    expect(fields?.parties).toEqual({ first: "Acme Ltd.", second: "Riverstone Inc." });
    expect(fields?.cover.deponent).toBe("Jane Doe");
    expect(affidavitSourceFields([["PLAINTIFF:", "ALPHA LTD.", "DEFENDANT:",
      "BETA LTD."].join("\n")])?.parties).toEqual({ first: "Alpha Ltd.", second: "Beta Ltd." });
  });
});
