import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthoritiesImporter, importStandaloneAuthoritiesFile } from "./authoritiesImport";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative } from "./structureNative";
import { Document, Packer, Paragraph, TextRun, FootnoteReferenceRun } from "docx";
import { authorityPassageTargets } from "./authoritiesBuild";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const scope = { userId: "user-1" };

it('preserves the reported hyphenated quotation and a second quotation at the same citation', async () => {
  const quotes = ['no evidence indicating that the mental condi-\ntion of the accused is inherently dangerous in any\nway.',
    'his mental condition poses no threat to public safety'];
  const bytes = await Packer.toBuffer(new Document({
    footnotes: { 1: { children: [new Paragraph('R. v. Bouchard-Lebrun, 2011 SCC 58 at para 83.')] } },
    sections: [{ children: [new Paragraph({ children: [
      new TextRun(`“${quotes[0]}” and “${quotes[1]}”`), new FootnoteReferenceRun(1),
    ] })] }],
  }));
  const state = await importStandaloneAuthoritiesFile({ filename: 'Brief.docx', fileType: 'docx', bytes, modified: 0 });
  expect(state.authorityOrder).toHaveLength(1);
  expect(authorityPassageTargets(state, state.authorityOrder[0])).toEqual([
    expect.objectContaining({ locatorKind: 'paragraph', locator: '83',
      exactQuotes: quotes.map(quote => quote.replace(/\s+/g, ' ')) }),
  ]);
});
let aliasDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_CITATOR_DB;
  if (aliasDirectory) await rm(aliasDirectory, { recursive: true, force: true });
  aliasDirectory = null;
});

async function useAliasGraph(rows: Array<[citation: string, decision: string]>) {
  aliasDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-authorities-alias-"));
  const databasePath = path.join(aliasDirectory, "citator.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE resolution (cited_key TEXT, path TEXT, file_row_number INTEGER)");
  const insert = database.prepare("INSERT INTO resolution VALUES (?, ?, 1)");
  const native = structureNative();
  rows.forEach(([citation, decision]) => insert.run(native.citationLookupKey(citation), decision));
  database.close();
  process.env.MIKE_CITATOR_DB = databasePath;
}

const scanNative = (texts: string[]) => {
  const native = structureNative();
  return {
    docxAuthorityTextUnits: vi.fn(async () => texts.map((text, index) => ({
      key: `footnote:${index + 1}`, kind: "footnote" as const, ordinal: index + 1,
      footnote_id: index + 1, page_numbers: [], text, footnote_refs: [],
    }))),
    pdfAuthorityTextUnits: vi.fn(),
    citationOccurrencesInText: (text: string) => native.citationOccurrencesInText(text),
    authorityReferencesInText: (text: string) => native.authorityReferencesInText(text),
    citationLookupKey: (text: string) => native.citationLookupKey(text),
  };
};

const receipt = (evidenceId: string, label: string): LegalEvidenceReceipt => ({
  evidence_id: evidenceId, provider: "a2aj", jurisdiction: "ca", source_class: "case",
  stable_source_id: "2016-scc-27", source_sha256: "c".repeat(64), scope: "passage",
  block_id: label, span_sha256: `${evidenceId}-sha`, span_text: "Evidence",
  citation: "2016 SCC 27", name: "R v Jordan", dataset: "SCC", language: "en",
  version: "2024-01-01", external_url: "https://example.test/jordan",
  locator: { kind: "paragraph", label }, resolver_version: "a2aj-inline-v1",
});

describe("authorities import application", () => {
  it("rejects unreadable Word inputs with an actionable error before creating a draft", async () => {
    const missing = new JSZip(); missing.file("[Content_Types].xml", "<Types/>");
    const malformed = new JSZip(); malformed.file("word/document.xml", "<w:document><w:body>");
    for (const bytes of [Buffer.alloc(0), Buffer.from("renamed text"),
      await missing.generateAsync({ type: "nodebuffer" }),
      await malformed.generateAsync({ type: "nodebuffer" })]) {
      await expect(importStandaloneAuthoritiesFile({ filename: "Broken.docx", fileType: "docx",
        bytes, modified: 0 })).rejects.toMatchObject({ status: 400,
          message: expect.stringContaining("Choose a readable .docx") });
    }
  });

  it("preserves service failures instead of reporting them as damaged source files", async () => {
    const failure = new Error("Native addon unavailable");
    await expect(importStandaloneAuthoritiesFile({ filename: "Brief.docx", fileType: "docx",
      bytes: Buffer.from("unused"), modified: 0 }, { read: vi.fn() as never }, {
      docxAuthorityTextUnits: async () => { throw failure; }, pdfAuthorityTextUnits: vi.fn(),
    })).rejects.toBe(failure);
  });

  it("propagates Form 66 fields from an imported filing", async () => {
    const lines = ["Court File No. T-982-19", "FEDERAL COURT", "BETWEEN:",
      "North Prairie Ltd.", "Applicant", "and", "Attorney General of Canada", "Respondent",
      "APPLICATION UNDER Federal Courts Act, section 18.1"];
    const native = { docxAuthorityTextUnits: vi.fn(async () => lines.map((text, ordinal) => ({
      key: `body:${ordinal}`, kind: "body" as const, ordinal, footnote_id: null,
      page_numbers: [], text, footnote_refs: [],
    }))), pdfAuthorityTextUnits: vi.fn(), citationOccurrencesInText: vi.fn(() => []),
    authorityReferencesInText: vi.fn(() => []), citationLookupKey: vi.fn(() => "") };

    const state = await importStandaloneAuthoritiesFile({ filename: "Memorandum.docx",
      fileType: "docx", bytes: Buffer.from("filing"), modified: 1 },
    { read: vi.fn() as never }, native);

    expect(state.cover).toEqual({ courtFileNumber: "T-982-19", partyGroups: [
      { role: "Applicant", parties: ["North Prairie Ltd."] },
      { role: "Respondent", parties: ["Attorney General of Canada"] },
    ], applicationUnder: "Federal Courts Act, section 18.1", title: "" });
  });

  it("coalesces reciprocal neutral, reporter, and French case citations before supra", async () => {
    const citations = ["2015 SCC 5", "[2015] 1 SCR 331", "2015 CSC 5"];
    await useAliasGraph(citations.map((citation) => [citation, "carter"]));
    const texts = [
      `Carter v Canada, ${citations[0]}.`,
      `Carter v Canada, ${citations[1]}.`,
      `Carter c Canada, ${citations[2]}.`,
      "Carter v Canada, supra note 1 at para 8.",
    ];

    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes: Buffer.from("brief"), modified: 1 },
    { read: vi.fn() as never }, scanNative(texts));

    expect(state.authorityOrder).toHaveLength(1);
    const authorityId = state.authorityOrder[0];
    expect(state.authorities[authorityId]).toMatchObject({
      id: structureNative().citationLookupKey(citations[0]), kind: "case",
      citation: citations[0],
    });
    expect(Object.values(state.occurrences).filter(({ kind }) => kind !== "reference")
      .map(({ citation, authorityId: id, kind }) => ({ citation, id, kind }))).toEqual(
      citations.map((citation) => ({ citation, id: authorityId, kind: "case" })),
    );
    expect(Object.values(state.occurrences).find(({ kind }) => kind === "reference"))
      .toMatchObject({ citation: "supra note 1", authorityId, reviewed: true,
        reference: { kind: "supra", targetAuthorityId: authorityId } });
  });

  it("does not merge asymmetric or ambiguous alias closures", async () => {
    const neutral = "2020 SCC 1", reporter = "[2020] 1 SCR 1";
    await useAliasGraph([[neutral, "decision-a"], [reporter, "decision-a"],
      [reporter, "decision-b"]]);
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes: Buffer.from("brief"), modified: 1 },
    { read: vi.fn() as never }, scanNative([neutral, reporter]));

    expect(state.authorityOrder).toEqual([neutral, reporter]
      .map((citation) => structureNative().citationLookupKey(citation)));
  });

  it("does not coalesce legislation through the case alias inventory", async () => {
    const citations = ["42 U.S.C. § 1983", "42 U.S.C. § 1985"];
    await useAliasGraph(citations.map((citation) => [citation, "not-a-case"]));
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes: Buffer.from("brief"), modified: 1 },
    { read: vi.fn() as never }, scanNative(citations));
    expect(state.authorityOrder).toEqual(citations
      .map((citation) => structureNative().citationLookupKey(citation)));
    expect(state.authorityOrder.map((id) => state.authorities[id].kind))
      .toEqual(["legislation", "legislation"]);
  });

  it("keeps standalone manual-source imports unresolved until source preparation", async () => {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph("Example v Example, 2024 ABKB 123 at para 7 [Example]."),
      new Paragraph("Ibid at para 9."),
      new Paragraph("Example, supra at para 11."),
    ] }] }));
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes, modified: 1, sourceMode: "manual-originals" });
    expect(state.authorityOrder).toHaveLength(1);
    expect(state.authorities[state.authorityOrder[0]].citation).toBe("2024 ABKB 123");
    expect(state.authorities[state.authorityOrder[0]].name).toBe("Example v Example");
    expect(state.authorities[state.authorityOrder[0]].source).toEqual({ kind: "unresolved" });
    expect(Object.values(state.occurrences).filter(({ kind }) => kind === "reference"))
      .toMatchObject([
        { citation: "Ibid", text: "Ibid at para 9", authoritySpan: { text: "Ibid" },
          pinpointSpan: { text: "9" }, sourceTextSha256: sha256("Ibid at para 9."),
          localOrdinal: 0, authorityId: state.authorityOrder[0], reviewed: true,
          reference: { kind: "ibid", targetAuthorityId: state.authorityOrder[0] } },
        { citation: "supra", text: "supra at para 11", authoritySpan: { text: "supra" },
          pinpointSpan: { text: "11" }, authorityId: state.authorityOrder[0], reviewed: true,
          reference: { kind: "supra", targetAuthorityId: state.authorityOrder[0] } },
      ]);
  });

  it("keeps a journal's author and title separate from its journal citation", async () => {
    const state = await importStandaloneAuthoritiesFile({ filename: "Article.docx", fileType: "docx",
      bytes: Buffer.from("article"), modified: 1, sourceMode: "manual-originals" },
    { read: vi.fn() as never }, scanNative([
      'John Smith, "Judicial Review" (2020) 58:2 Alta L Rev 123 at 130.',
    ]));
    expect(state.authorityOrder).toHaveLength(1);
    expect(state.authorities[state.authorityOrder[0]]).toMatchObject({ kind: "commentary",
      name: 'John Smith, "Judicial Review"', citation: "(2020) 58:2 Alta L Rev 123" });
    expect(Object.values(state.occurrences)[0].coreSpan?.text).toBe("(2020) 58:2 Alta L Rev 123");
  });

  it("keeps shared case styling within each parallel citation's own span", async () => {
    const text = "😀 The proportionality analysis originates in R v Oakes, " +
      "[1986] 1 SCR 103, 1986 CanLII 46 (SCC).";
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph(text),
    ] }] }));
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes, modified: 1 });
    const unit = state.units.find(({ text: value }) => value === text)!;
    const occurrences = unit.occurrenceIds.map((id) => state.occurrences[id]);

    expect(occurrences).toHaveLength(2);
    expect(occurrences.map(({ authoritySpan, coreSpan }) => ({
      authority: authoritySpan.text, core: coreSpan.text,
    }))).toEqual([
      { authority: "R v Oakes, [1986] 1 SCR 103", core: "[1986] 1 SCR 103" },
      { authority: "1986 CanLII 46", core: "1986 CanLII 46" },
    ]);
  });

  it("starts a case name after the pinpoint of the reference before it", async () => {
    const text = "Campbell, supra note 1 at para 43. R v Lukacs, 2021 BCSC 1769 at para 40.";
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph(text),
    ] }] }));
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes, modified: 1 });
    const unit = state.units.find(({ text: value }) => value === text)!;
    expect(unit.occurrenceIds.map((id) => state.occurrences[id]).map(
      ({ text: value, pinpointSpan }) => [value, pinpointSpan?.text])).toEqual([
      ["supra note 1 at para 43", "43"],
      ["R v Lukacs, 2021 BCSC 1769 at para 40", "40"],
    ]);
  });

  it("finds ordinary references through a real PDF projection", async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("R v Grant, 2009 SCC 32", { x: 50, y: 700, font, size: 12 });
    page.drawText("Ibid at para 7.", { x: 50, y: 680, font, size: 12 });
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.pdf",
      fileType: "pdf", bytes: Buffer.from(await pdf.save()), modified: 1 });
    const reference = Object.values(state.occurrences).find(({ kind }) => kind === "reference");
    expect(state.authorityOrder).toHaveLength(1);
    expect(reference).toMatchObject({ citation: "Ibid", authorityId: state.authorityOrder[0],
      reference: { kind: "ibid", targetAuthorityId: state.authorityOrder[0] } });
  });

  it("preserves a complete PDF citation and pinpoint spanning layout units and pages", async () => {
    const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.TimesRoman);
    for (const text of ["Liu v. T & H Machine, Inc., 191 F.3d 790,", "798 (7th Cir. 1999)."] ) {
      const page = document.addPage([612, 792]);
      page.drawText("Synthetic public PDF fixture", { x: 72, y: 750, font, size: 12 });
      page.drawText(text, { x: 72, y: 650, font, size: 12 });
    }
    const bytes = Buffer.from(await document.save());
    const state = await importStandaloneAuthoritiesFile({ filename: "Multiline.pdf", fileType: "pdf", bytes, modified: 1 });
    expect(state.authorityOrder).toHaveLength(1);
    const occurrence = Object.values(state.occurrences)[0], unit = state.units.find(({ id }) => id === occurrence.unitId)!;
    expect(occurrence.authoritySpan.text).toBe("Liu v. T & H Machine, Inc., 191 F.3d 790");
    expect(occurrence.coreSpan.text).toBe("191 F.3d 790");
    expect(occurrence.pinpointSpan?.text).toBe("798");
    expect(occurrence.pinpoints).toEqual([{ kind: "page", text: "798" }]);
    expect(occurrence.text).toBe("Liu v. T & H Machine, Inc., 191 F.3d 790,\n\n798 (7th Cir. 1999)");
    expect(unit.pageNumbers).toEqual([1, 2]);
    expect(unit.text.slice(occurrence.pinpointSpan!.start, occurrence.pinpointSpan!.end)).toBe("798");
    expect(occurrence.sourceTextSha256).toBe(sha256(unit.text));
  });

  it("links supra notes only when their native reference target is unambiguous", async () => {
    const runtime = structureNative();
    const text = [
      "R v Smith, 2020 SCC 1; R v Smith, 2020 SCC 2.",
      "Gamma v Delta, 2021 SCC 3.",
      "R v Smith, supra note 1 at para 4.",
      "Gamma v Delta, supra note 2 at para 5.",
    ];
    const units = text.map((value, index) => ({ key: `footnote:${index + 1}`,
      kind: "footnote" as const, ordinal: index + 1, footnote_id: index + 1,
      page_numbers: [], text: value, footnote_refs: [] }));
    const native = {
      docxAuthorityTextUnits: vi.fn(), pdfAuthorityTextUnits: vi.fn(() => units),
      citationOccurrencesInText: (value: string) => runtime.citationOccurrencesInText(value),
      authorityReferencesInText: (value: string) => runtime.authorityReferencesInText(value),
      citationLookupKey: (value: string) => runtime.citationLookupKey(value),
    };
    const pdf = await PDFDocument.create(); pdf.addPage();
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.pdf",
      fileType: "pdf", bytes: Buffer.from(await pdf.save()), modified: 1 },
    { read: vi.fn(async () => ({})) as never }, native);
    const references = Object.values(state.occurrences)
      .filter(({ kind }) => kind === "reference");

    expect(references[0]).toMatchObject({ citation: "supra note 1", authorityId: null,
      reference: null, reviewed: false, pinpointSpan: { text: "4" } });
    expect(state.units[2].occurrenceIds).toContain(references[0].id);
    expect(references[1]).toMatchObject({ citation: "supra note 2", reviewed: true,
      reference: { kind: "supra", targetAuthorityId: references[1].authorityId } });
  });

  const footnoteImport = async (text: string[]) => {
    const units = text.map((value, index) => ({ key: `footnote:${index + 1}`,
      kind: "footnote" as const, ordinal: index + 1, footnote_id: index + 1,
      page_numbers: [], text: value, footnote_refs: [] }));
    const pdf = await PDFDocument.create(); pdf.addPage();
    return importStandaloneAuthoritiesFile({ filename: "Paper.pdf", fileType: "pdf",
      bytes: Buffer.from(await pdf.save()), modified: 1 }, { read: vi.fn(async () => ({})) as never },
    { docxAuthorityTextUnits: vi.fn(), pdfAuthorityTextUnits: vi.fn(() => units) });
  };

  it("keeps a supra note and ibid that cite a hearing transcript off the case's decision", async () => {
    const state = await footnoteImport([
      "Halvorsen v Tidewater Ferries Ltd, 2030 SCC 12 [Halvorsen].",
      "See Halvorsen v Tidewater Ferries Ltd, 2030 SCC 12 (Transcript of hearing at 41 lines 3–8) [Halvorsen transcript].",
      "Halvorsen transcript, supra note 2 at 44 lines 1–6.",
      "Ibid at 45.",
      "Halvorsen, supra note 1 at para 30.",
    ]);
    const linked = state.units.map(({ occurrenceIds }) => occurrenceIds.map((id) =>
      state.occurrences[id].authorityId));
    const decision = state.authorityOrder[0];
    // The transcript's own citation names the case; references to it do not reach the decision.
    expect(state.authorityOrder).toEqual([decision]);
    expect(linked).toEqual([[decision], [decision], [null], [null], [decision]]);
  });

  it("names one source for a citation written alike, but not for two works sharing an imprint", async () => {
    const state = await footnoteImport([
      "See the Harbour Pilotage Act, 2029.",
      "As the Harbour Pilotage Act, 2029 provides.",
      "Ada Quill, Tides of the North (Halifax: Tidewater Press, 2020).",
      "Bram Ostrander, Salt and Ledger (Halifax: Tidewater Press, 2020).",
    ]);
    const authorityOf = (unit: number) => state.units[unit].occurrenceIds
      .map((id) => state.occurrences[id].authorityId);
    expect(authorityOf(0)).toHaveLength(1);
    expect(authorityOf(1)).toEqual(authorityOf(0));
    expect(authorityOf(2)).toHaveLength(1);
    expect(authorityOf(3)).toHaveLength(1);
    expect(authorityOf(3)).not.toEqual(authorityOf(2));
  });

  it("keeps a pinpoint's ff with the citation and locates its paragraph", async () => {
    const state = await footnoteImport(["Halvorsen v Tidewater Ferries Ltd, 2030 SCC 12 at para 41ff."]);
    const [occurrence] = Object.values(state.occurrences);
    expect(occurrence.text.endsWith("41ff")).toBe(true);
    expect(occurrence.pinpoints).toEqual([{ kind: "paragraph", text: "41" }]);
  });

  it("links Ibid and supra in reading order and never past an unresolved reference", async () => {
    const runtime = structureNative();
    const units = [
      { key: "body:0", kind: "body" as const, ordinal: 0, footnote_id: null, page_numbers: [],
        text: "The test is in R v Grant, 2009 SCC 32.", footnote_refs: [[1, 38]] as Array<[number, number]> },
      { key: "body:1", kind: "body" as const, ordinal: 1, footnote_id: null, page_numbers: [],
        text: "Delay is governed by R v Jordan, 2016 SCC 27.", footnote_refs: [[2, 45]] as Array<[number, number]> },
      { key: "footnote:1", kind: "footnote" as const, ordinal: 0, footnote_id: 1, page_numbers: [],
        text: "Ibid at para 9.", footnote_refs: [] },
      { key: "footnote:2", kind: "footnote" as const, ordinal: 1, footnote_id: 2, page_numbers: [],
        text: "Smith v Jones, 2012 SCC 34 [Smith]; Goldsmith, supra at para 4; Ibid at para 3.",
        footnote_refs: [] },
    ];
    const native = {
      docxAuthorityTextUnits: vi.fn(), pdfAuthorityTextUnits: vi.fn(() => units),
      citationOccurrencesInText: (value: string) => runtime.citationOccurrencesInText(value),
      authorityReferencesInText: (value: string) => runtime.authorityReferencesInText(value),
      citationLookupKey: (value: string) => runtime.citationLookupKey(value),
    };
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.pdf",
      fileType: "pdf", bytes: Buffer.from("%PDF-1.7\n%%EOF"), modified: 1 },
    { read: vi.fn(async () => ({})) as never }, native);
    const reference = (unit: string, citation: string) => Object.values(state.occurrences)
      .find((item) => item.unitId === unit && item.kind === "reference" && item.citation === citation);
    const grant = Object.values(state.authorities).find(({ citation }) => citation === "2009 SCC 32")!;

    // The footnote anchored after Grant reads Grant, not the later body citation of Jordan.
    expect(reference("footnote:1", "Ibid")).toMatchObject({ authorityId: grant.id });
    // "Goldsmith" is not the short form "Smith", and nothing after it may inherit Smith.
    expect(reference("footnote:2", "supra")).toMatchObject({ authorityId: null });
    expect(reference("footnote:2", "Ibid")).toMatchObject({ authorityId: null });
  });

  it("keeps a pinpoint range as one pinpoint", async () => {
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\n%%EOF"), modified: 1 }, { read: vi.fn(async () => ({})) as never },
    { ...scanNative([]), pdfAuthorityTextUnits: vi.fn(() => [{ key: "body:0", kind: "body" as const,
      ordinal: 0, footnote_id: null, page_numbers: [], footnote_refs: [],
      text: "R v Jordan, 2016 SCC 27 at paras 5, 9 and 71-86; R v Oakes, [1986] 1 SCR 103 at 138 to 39." }]) });
    expect(Object.values(state.occurrences).map(({ pinpoints }) => pinpoints)).toEqual([
      [{ kind: "paragraph", text: "5" }, { kind: "paragraph", text: "9" }, { kind: "paragraph", text: "71-86" }],
      [{ kind: "page", text: "138-39" }],
    ]);
  });

  it("imports exact grounded receipt seeds without reparsing", async () => {
    const key = "2016-scc-27";
    const citationOccurrencesInText = vi.fn(() => {
      throw new Error("receipt-backed authorities must not be reparsed");
    });
    const native = {
      citationOccurrencesInText,
      citationLookupKey: vi.fn(() => { throw new Error("known key must not be rebuilt"); }),
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("document parser must not run"); }),
      pdfAuthorityTextUnits: vi.fn(() => { throw new Error("document parser must not run"); }),
    };
    const importer = createAuthoritiesImporter({} as DocumentStore,
      { read: vi.fn() as never }, native as never);

    const state = await importer.draft(scope, { kind: "receipts", seeds: [{
      authorityKey: key, receipts: [receipt("e1", "12"), receipt("e2", "14")],
    }] });

    expect(state.authorities[key]).toMatchObject({ name: "R v Jordan",
      source: { kind: "resolved" }, sourceIdentity: {
        stableSourceId: "2016-scc-27", sourceSha256: "c".repeat(64),
        version: "2024-01-01" } });
    expect(citationOccurrencesInText).not.toHaveBeenCalled();
    expect(native.citationLookupKey).not.toHaveBeenCalled();
  });

  it("uses a matching assistant citation ledger without reading or reparsing the DOCX", async () => {
    const sourceSha256 = "a".repeat(64), unitText = "R v Jordan, 2016 SCC 27";
    const readBytes = vi.fn(() => { throw new Error("ledger-backed DOCX must not be read"); });
    const ledger = {
      schemaVersion: "beaver.authority-ledger.v1" as const,
      seeds: [{
        key: "2016-scc-27", kind: "case" as const, provider: "a2aj",
        stableSourceId: "2016-scc-27", sourceSha256: "c".repeat(64),
        citation: "2016 SCC 27", name: "R v Jordan", version: "2024-01-01",
        externalUrl: "https://example.test/jordan", evidenceIds: ["e_receipt0001"],
        locators: [{ kind: "paragraph", label: "12" }],
      }],
      occurrences: [{
        id: "body:0:ledger:0", markerId: "jordan", targetId: "2016-scc-27",
        authorityKey: "2016-scc-27", unit: { id: "body:0", kind: "body" as const,
          ordinal: 0, footnoteId: null, footnoteRefs: [], pageNumbers: [],
          text: unitText, sourceTextSha256: sha256(unitText) },
        start: 0, end: unitText.length, text: unitText, displayedForm: "full" as const,
        pinpoints: [{ kind: "paragraph" as const, text: "12" }],
        evidenceIds: ["e_receipt0001"], localOrdinal: 0,
      }],
    };
    const documents = {
      projectionSource: vi.fn(async () => ({ documentId: "brief", versionId: "v1",
        fileType: "docx", sourceSha256, readBytes,
        provenance: { actor: "assistant" as const, generation: { authorityLedger: ledger } } })),
      metadata: vi.fn(async () => ({ current_version_id: "v1", filename: "Brief.docx" })),
    } as unknown as DocumentStore;
    const native = {
      citationOccurrencesInText: vi.fn(() => { throw new Error("ledger must not be scanned"); }),
      citationLookupKey: vi.fn(() => { throw new Error("ledger key must not be rebuilt"); }),
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("DOCX parser must not run"); }),
      pdfAuthorityTextUnits: vi.fn(() => { throw new Error("PDF parser must not run"); }),
    };
    const read = vi.fn(() => { throw new Error("projection must not run"); });

    const state = await createAuthoritiesImporter(documents, { read: read as never },
      native as never).draft(scope, { kind: "document", documentId: "brief",
        version: "latest" });

    expect(state.authorityOrder).toEqual(["2016-scc-27"]);
    expect(state.occurrences["body:0:ledger:0"]).toMatchObject({
      text: unitText, authorityId: "2016-scc-27", reviewed: true,
      evidenceIds: ["e_receipt0001"],
    });
    expect(state.ledger?.document).toEqual({ documentId: "brief", versionId: "v1",
      sha256: sourceSha256 });
    expect(readBytes).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(native.docxAuthorityTextUnits).not.toHaveBeenCalled();
    expect(native.citationOccurrencesInText).not.toHaveBeenCalled();
  });

  it("carries exact PDF body pages from the shared projection into static cited-at data", async () => {
    const bytes = Buffer.from("%PDF-1.7\n%%EOF"), sourceSha256 = sha256(bytes);
    const projection = { documentId: "brief", versionId: "v1" };
    const readBytes = vi.fn(() => { throw new Error("PDF bytes must use the projection"); });
    const documents = {
      projectionSource: vi.fn(async () => ({ documentId: "brief", versionId: "v1",
        fileType: "pdf", sourceSha256, readBytes })),
      metadata: vi.fn(async () => ({ current_version_id: "v1", filename: "Brief.pdf" })),
    } as unknown as DocumentStore;
    const pdfAuthorityTextUnits = vi.fn(() => [{ key: "body:0", kind: "body" as const,
      ordinal: 0, footnote_id: null, page_numbers: [2, 4], text: "2024 FCA 1",
      footnote_refs: [] }]);
    const native = {
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("DOCX parser must not run"); }),
      pdfAuthorityTextUnits,
      citationOccurrencesInText: vi.fn(() => []),
      authorityReferencesInText: vi.fn(() => []), citationLookupKey: vi.fn(),
    };
    const read = vi.fn(async () => projection);
    const importer = createAuthoritiesImporter(documents, { read: read as never }, native as never);

    const state = await importer.draft(scope, { kind: "document", documentId: "brief",
      version: "latest" });

    expect(state.units[0].pageNumbers).toEqual([2, 4]);
    expect(read).toHaveBeenCalledOnce();
    expect(pdfAuthorityTextUnits).toHaveBeenCalledWith(projection);
    expect(readBytes).not.toHaveBeenCalled();
  });
});
