import { describe, expect, it } from "vitest";
import { sourceDocumentFields } from "./sourceFields";

describe("court record source fields", () => {
  it("recovers the affidavit cover, parties, jurat, and referenced exhibit slots", () => {
    expect(sourceDocumentFields([
      ["Court File No. 2401-12345", "CALGARY JUDICIAL CENTRE", "COURT OF KING'S BENCH OF ALBERTA",
        "Plaintiff: ALPHA PERSON", "Defendant: BETA PERSON", "Affidavit #7 of SAMPLE DEPONENT"].join("\n"),
      "The January order is attached as Exhibit A. This is Exhibit B referred to in the Affidavit.",
      "SWORN BEFORE ME at Calgary, Alberta this 2nd day of January 2026",
    ])).toEqual({
      cover: {
        courtName: "COURT OF KING'S BENCH OF ALBERTA",
        courtFileNumber: "2401-12345",
        registry: "CALGARY",
        affidavitNumber: "7",
        deponent: "SAMPLE DEPONENT",
        swornDate: "January 2, 2026",
        swornPlace: "Calgary, Alberta",
      },
      exhibitLabels: ["A"],
      exhibitMentions: { A: ["The January order is attached as Exhibit A."] },
      explicitExhibitLabel: "B",
      entryTitle: "Affidavit of SAMPLE DEPONENT",
      entryDate: "January 2, 2026",
    });
  });

  it("reads a scanned affidavit's deponent, place, and date from flattened OCR text", () => {
    // OCR of scanned-affidavit.pdf returns one flat line per page, and the recital's comma
    // after "I" is lost, so only the shape of a name can bound the reading.
    const fields = sourceDocumentFields([
      "AFFIDAVIT OF JORDAN JAMES PELECH I JORDAN JAMES PELECH, of the City of Edmonton, in the Province of Alberta, SWEAR AND SAY THAT: 1. I am the Operations Supervisor for the City of Edmonton and as such have personal knowledge of the matters deposed to in this Affidavit. 2. On July 15, 2024 I attended at the Site and observed the encampment described in the Statement of Claim.",
      "3. Attached as Exhibit A is a photograph of the Site taken on that date. 4. Attached as Exhibit B is a photograph of the items removed. SWORN BEFORE ME at the City of Edmonton, in the Province of Alberta, this 22nd day of May, 2026.",
      "", "",
    ]);

    expect(fields?.cover).toEqual({
      deponent: "JORDAN JAMES PELECH",
      swornDate: "May 22, 2026",
      swornPlace: "Edmonton, Alberta",
    });
    expect(fields?.entryTitle).toBe("Affidavit of JORDAN JAMES PELECH");
    expect(fields?.exhibitLabels).toEqual(["A", "B"]);
  });

  it("never accepts a recital paragraph as a deponent name", () => {
    const recital = "I JORDAN JAMES PELECH, of the City of Edmonton, in the Province of Alberta, SWEAR AND SAY THAT: 1. I am the Operations Supervisor for the City of Edmonton.";
    for (const page of [`Deponent: ${recital}`, `AFFIDAVIT OF JORDAN JAMES PELECH ${recital}`]) {
      expect(sourceDocumentFields([page])?.cover.deponent).toBe("JORDAN JAMES PELECH");
    }
    for (const page of [
      "Deponent: This affidavit is made in support of the application and the facts set out below are true.",
      "Affidavit of the applicant filed in this action on July 15, 2024.",
      "Affidavit of 22 boxes of records seized from the Site.",
    ]) {
      expect(sourceDocumentFields([page])?.cover).not.toHaveProperty("deponent");
    }
  });

  it("keeps each distinct affidavit statement with its exhibit slot", () => {
    const fields = sourceDocumentFields([[
      "1. The January order is attached as Exhibit A.",
      "The same order records parenting time and is attached as Exhibit A!",
      "The respondent's email is attached as Exhibit B;",
      "The respondents email is attached as Exhibit B.",
      "This is Exhibit C referred to in the Affidavit.",
    ].join(" ")]);

    expect(fields?.exhibitLabels).toEqual(["A", "B"]);
    expect(fields?.exhibitMentions).toEqual({
      A: ["The January order is attached as Exhibit A.",
        "The same order records parenting time and is attached as Exhibit A!"],
      B: ["The respondent's email is attached as Exhibit B;"],
    });
  });

  it("does not turn dates, registries, or caption fragments into parties", () => {
    const fields = sourceDocumentFields(["28-Jul-26\nVancouver\n(collectively\nthe\nChildren).\n8.\nRespondent"]);
    expect(fields).not.toHaveProperty("partyGroups");
    expect(fields).not.toHaveProperty("partyStyleId");
  });

  it("preserves legal capitalization in extracted names and acronyms", () => {
    const fields = sourceDocumentFields([["EDMONTON JUDICIAL CENTRE",
      "Affidavit of JANE McDONALD", "Counsel: IBM CANADA LTD."].join("\n")]);
    expect(fields?.cover).toMatchObject({
      registry: "EDMONTON", deponent: "JANE McDONALD", counselName: "IBM CANADA LTD.",
    });
  });

  it("reads the generated Federal Court cover used by nested records", () => {
    expect(sourceDocumentFields([["Court File No. T-982-19", "FEDERAL COURT", "BETWEEN:",
      "North Prairie Ltd.", "Applicant", "- and -", "Riverstone Inc.", "Respondent",
      "APPLICATION UNDER Federal Courts Act, section 18.1", "MOTION RECORD"].join("\n")]))
      .toMatchObject({ cover: { courtFileNumber: "T-982-19" } });
  });

  it("reads the official Federal Court motion-record cover, not its index rows", () => {
    const fields = sourceDocumentFields([
      ["No. T-982-19", "FEDERAL COURT", "Between", "Attorney General of British Columbia",
        "Plaintiff", "And", "Attorney General of Alberta", "Defendant", "MOTION RECORD",
        "The Attorney General of British Columbia’s",
        "Response to the Defendant’s Application to Strike the Action",
        "Hearing Date: September 12-13, 2019"].join("\n"),
      ["INDEX", "TAB", "PLEADING", "PAGE", "1",
        "Plaintiff’s Memorandum of Argument in Response to the Defendant’s",
        "Application to Strike, dated September 11, 2019", "1"].join("\n"),
      "TAB 1",
    ]);

    expect(fields).toMatchObject({
      cover: { courtFileNumber: "T-982-19" },
      entryTitle: "MOTION RECORD — The Attorney General of British Columbia’s Response to the Defendant’s Application to Strike the Action",
    });
    expect(fields).not.toHaveProperty("entryDate");
  });

  it("recovers the stated date without inventing an entry title", () => {
    expect(sourceDocumentFields([["Court File No. T-982-19", "FEDERAL COURT", "BETWEEN:",
      "North Prairie Ltd.", "Applicant", "and", "Canada", "Respondent",
      "NOTICE OF APPLICATION"].join("\n"),
    "DATED at Calgary, Alberta this 4th day of September, 2026."]))
      .toMatchObject({ entryDate: "September 4, 2026" });
  });

  it("does not use a bare Order line as an entry title", () => {
    expect(sourceDocumentFields(["Court file number: 2401-12345\nOrder"]))
      .not.toHaveProperty("entryTitle");
  });

  it("keeps AP-5 metadata without guessing parties", () => {
    const fields = sourceDocumentFields([["COURT OF APPEAL FILE NUMBER: 2403-0001AC",
      "TRIAL COURT FILE NUMBER: 2201-12345", "REGISTRY OFFICE: Calgary",
      "PLAINTIFF/APPLICANT:", "ACME Holdings Inc.", "STATUS ON APPEAL:", "Appellant",
      "DEFENDANT/RESPONDENT:", "RIVERSTONE LTD.", "STATUS ON APPEAL:", "Respondent",
      "INTERVENER:", "Public Interest Centre", "STATUS ON APPEAL:", "Intervener",
      "DECISION MAKER APPEALED FROM: The Honourable Justice A. Ng",
      "DECISION DATE: March 4, 2026", "DECISION FILING DATE: March 5, 2026"].join("\n")]);
    expect(fields).toMatchObject({ cover: {
      courtFileNumber: "2403-0001AC", lowerCourtFileNumber: "2201-12345", registry: "Calgary",
      decisionMaker: "The Honourable Justice A. Ng", decisionDate: "March 4, 2026",
      decisionFileDate: "March 5, 2026",
    } });
    expect(fields).not.toHaveProperty("partyStyleId");
  });

  it("reads official AP-5 decision fields without propagating blank contact labels", () => {
    const fields = sourceDocumentFields([["COURT OF APPEAL OF ALBERTA", "Form AP-5",
      "COURT OF APPEAL FILE NUMBER:", "987654321", "TRIAL COURT FILE NUMBER:", "123456789",
      "REGISTRY OFFICE:", "Edmonton", "PLAINTIFF/APPLICANT:", "John Doe",
      "STATUS ON APPEAL:", "Appellant", "DEFENDANT/RESPONDENT:", "Jane Smith",
      "STATUS ON APPEAL:", "Respondent", "DOCUMENT:", "Appeal Record",
      "Appeal from the Decision of", "The Honourable Justice J. Jones",
      "Dated the 31st day of May, 2023", "Filed the 15th day of July, 2023",
      "APPEAL RECORD", "Lawyer for John Doe", "Name", "Address", "Phone", "Fax", "Email",
      "Lawyer for Jane Smith", "Name", "Address", "Phone", "Fax", "Email"].join("\n")]);

    expect(fields?.cover).toMatchObject({ courtFileNumber: "987654321",
      decisionMaker: "The Honourable Justice J. Jones", decisionDate: "May 31, 2023",
      decisionFileDate: "July 15, 2023" });
    expect(fields?.cover).not.toHaveProperty("counselPhone");
    expect(fields?.cover).not.toHaveProperty("counselFax");
    expect(fields?.cover).not.toHaveProperty("counselEmail");
  });
});
