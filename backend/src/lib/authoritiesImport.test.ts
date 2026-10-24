import { describe, expect, it, vi } from "vitest";
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
it("keeps the number Word prints for each footnote, past an author's note drawn as a symbol", async () => {
  const note = (text: string) => ({ children: [new Paragraph(text)] });
  const source = await Packer.toBuffer(new Document({
    footnotes: { 1: note("The author thanks the river board."), 2: note("Alder v Birch, 2031 ONCA 5."),
      3: note("Cedar v Dogwood, 2030 ABKB 417 at para 9.") },
    sections: [{ children: [new Paragraph({ children: [new TextRun("A heading"), new FootnoteReferenceRun(1)] }),
      new Paragraph({ children: [new TextRun("First point."), new FootnoteReferenceRun(2),
        new TextRun(" Second point."), new FootnoteReferenceRun(3)] })] }],
  }));
  // Word's own "*" note: the reference prints the mark that follows it, here a Symbol-font asterisk.
  const zip = await JSZip.loadAsync(source);
  const document = await zip.file("word/document.xml")!.async("string");
  const bytes = await zip.file("word/document.xml", document.replace(/<w:footnoteReference w:id="1"\/>/u,
    '<w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:sym w:font="Symbol" w:char="F02A"/>'))
    .generateAsync({ type: "nodebuffer" });
  const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx", fileType: "docx", bytes, modified: 0 });
  expect(state.units.filter(({ kind }) => kind === "footnote").map(({ noteNumber }) => noteNumber)).toEqual([null, 1, 2]);
});

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
        { citation: "supra", text: "Example, supra at para 11", authoritySpan: { text: "Example, supra" },
          pinpointSpan: { text: "11" }, authorityId: state.authorityOrder[0], reviewed: true,
          reference: { kind: "supra", targetAuthorityId: state.authorityOrder[0] } },
      ]);
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
      [text.slice(0, text.indexOf(".")), "43"],
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

  const footnoteImport = async (text: string[]) => {
    const units = text.map((value, index) => ({ key: `footnote:${index + 1}`,
      kind: "footnote" as const, ordinal: index + 1, footnote_id: index + 1,
      page_numbers: [], text: value, footnote_refs: [] }));
    const pdf = await PDFDocument.create(); pdf.addPage();
    return importStandaloneAuthoritiesFile({ filename: "Paper.pdf", fileType: "pdf",
      bytes: Buffer.from(await pdf.save()), modified: 1 }, { read: vi.fn(async () => ({})) as never },
    { docxAuthorityTextUnits: vi.fn(), pdfAuthorityTextUnits: vi.fn(() => units) });
  };

});
