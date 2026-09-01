import JSZip from "jszip";
import { Document as WordDocument, Packer, Paragraph, TextRun } from "docx";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber,
  PDFRawStream, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildAuthorities } from "./authoritiesBuild";
import { createAuthoritiesDraft, type AuthoritiesDraft,
  type AuthorityIdentity } from "./authoritiesDomain";
import { sha256 } from "./hash";

async function sourcePdf(label: string, sizes: Array<[number, number]>) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([width, height], index) => {
    const page = pdf.addPage([width, height]);
    page.drawText(`${label} page ${index + 1}`, { x: 36, y: height - 50, font, size: 14 });
  });
  return Buffer.from(await pdf.save());
}

function pageContent(document: PDFDocument, page: ReturnType<PDFDocument["getPage"]>) {
  const contents = page.node.Contents();
  const items = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return items.map((item) => {
    const stream = item instanceof PDFRawStream ? item : document.context.lookup(item, PDFRawStream);
    return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  }).join("\n");
}

function attached(
  id: string, kind: AuthorityIdentity["kind"], citation: string, name: string,
  bindingRole: string, bytes: Uint8Array,
): AuthorityIdentity {
  return { id, key: `${kind}:${id}`, kind, citation, name, displayName: null,
    evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
    source: { kind: "attached", bindingRole,
      filename: `${id}.pdf`, sourceSha256: sha256(bytes), sourceUrl: null } };
}

function draft(
  casePdf: Uint8Array, legislationPdf: Uint8Array, imported = false,
): AuthoritiesDraft {
  const caseAuthority = attached("grant", "case", "2009 SCC 32", "R v Grant",
    "source:grant", casePdf);
  const legislation = attached("fca", "legislation", "RSC 1985, c F-7",
    "Federal Courts Act", "source:fca", legislationPdf);
  const commentary: AuthorityIdentity = { id: "article", key: "commentary:article",
    kind: "commentary", citation: "(2024) 10 Legal Rev 1", name: "Useful article",
    displayName: null, evidenceIds: ["receipt-commentary"],
    locators: [{ kind: "page", label: "8" }], excluded: true,
    sourceIdentity: { provider: "journal", stableSourceId: "article-1",
      sourceSha256: "a".repeat(64), version: "2024-01",
      externalUrl: "https://example.test/article" }, source: { kind: "resolved" } };
  const occurrences = {
    grant: { id: "grant", unitId: "body:1", start: 0, end: 11, text: "2009 SCC 32",
      kind: "case" as const, citation: "2009 SCC 32", authorityId: "grant", reference: null,
      pinpoints: [{ kind: "paragraph" as const, text: "12" }], evidenceIds: ["evidence-1"],
      sourceTextSha256: "body-sha", localOrdinal: 0, reviewed: true },
    fca: { id: "fca", unitId: "footnote:7", start: 0, end: 17,
      text: "RSC 1985, c F-7", kind: "legislation" as const,
      citation: "RSC 1985, c F-7", authorityId: "fca", reference: null, pinpoints: [],
      evidenceIds: [], sourceTextSha256: "footnote-sha", localOrdinal: 0, reviewed: true },
    article: { id: "article", unitId: "body:2", start: 0, end: 27,
      text: "(2024) 10 Legal Rev 1 note", kind: "commentary" as const,
      citation: "(2024) 10 Legal Rev 1", authorityId: "article", reference: null,
      pinpoints: [{ kind: "page" as const, text: "8" }], evidenceIds: [],
      sourceTextSha256: "article-text-sha", localOrdinal: 0, reviewed: true },
  };
  return {
    schemaVersion: "beaver.authorities-draft.v1",
    import: imported ? { kind: "document", bindingRole: "source",
      filename: "Brief.docx", fileType: "docx",
      snapshot: { documentId: "brief-document", versionId: "brief-v2",
        sha256: "9".repeat(64) } } : { kind: "manual" },
    outputMode: "both", insertIntoDocument: false, ledger: null,
    bindings: {
      "source:grant": { kind: "local-file", handleId: "grant-handle",
        lastSeen: { name: "grant.pdf", size: casePdf.length, modified: 10,
          sha256: sha256(casePdf) } },
      "source:fca": { kind: "document", documentId: "law-document",
        version: { versionId: "law-v3", sha256: sha256(legislationPdf) } },
      ...(imported ? { source: { kind: "document" as const,
        documentId: "brief-document", version: "latest" as const } } : {}),
    },
    units: [
      { id: "body:1", kind: "body", ordinal: 1, footnoteId: null,
        footnoteRefs: [[7, 0]], pageNumbers: [3, 5], text: "2009 SCC 32",
        occurrenceIds: ["grant"] },
      { id: "footnote:7", kind: "footnote", ordinal: 2, footnoteId: 7,
        footnoteRefs: [], pageNumbers: [7], text: "RSC 1985, c F-7",
        occurrenceIds: ["fca"] },
      { id: "body:2", kind: "body", ordinal: 3, footnoteId: null,
        footnoteRefs: [], pageNumbers: [8], text: "(2024) 10 Legal Rev 1 note",
        occurrenceIds: ["article"] },
    ],
    occurrences,
    authorities: { grant: caseAuthority, fca: legislation, article: commentary },
    authorityOrder: ["article", "fca", "grant"],
  };
}

describe("Authorities output builder", () => {
  it("builds an inspectable grouped DOCX and indexed, linked, bookmarked PDF book", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600], [500, 600]]);
    const input = { draft: draft(casePdf, legislationPdf, true),
      title: "Appeal Brief", workProduct: { id: "authorities-1", revision: 4 },
      sources: { "source:grant": { bytes: casePdf,
        ocrTextByPage: ["Recognized scanned decision"] },
        "source:fca": { bytes: legislationPdf }, source: { resolved: {
          kind: "document", documentId: "brief-document", versionId: "brief-v2",
          filename: "Brief.docx", sha256: "9".repeat(64),
        } } } } satisfies Parameters<typeof buildAuthorities>[0];
    const result = await buildAuthorities(input);

    expect(Object.keys(result.artifacts).sort()).toEqual(["book", "table"]);
    expect(result.artifacts.table).toMatchObject({ role: "table",
      filename: "Appeal Brief.table-of-authorities.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pageCount: null });
    expect(result.artifacts.book).toMatchObject({ role: "book",
      filename: "Appeal Brief.book-of-authorities.pdf", mimeType: "application/pdf",
      pageCount: 5 });
    expect(result.artifacts.book?.receipt).toMatchObject({
      schemaVersion: "beaver.work-product-build.v2",
      workProduct: { id: "authorities-1", kind: "authorities", revision: 4 },
      inputs: expect.arrayContaining([expect.objectContaining({ role: "source:fca",
        resolved: { kind: "document", documentId: "law-document", versionId: "law-v3",
          filename: "fca.pdf", sha256: sha256(legislationPdf) } }),
      { role: "source", resolved: { kind: "document", documentId: "brief-document",
        versionId: "brief-v2", filename: "Brief.docx", sha256: "9".repeat(64) } }]),
      output: { role: "book", filename: "Appeal Brief.book-of-authorities.pdf",
        mimeType: "application/pdf", pageCount: 5, sha256: result.artifacts.book?.sha256 },
      settings: { settingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sourceReceiptIds: ["evidence-1", "receipt-commentary"],
        audit: { effective: null, valuesJson: expect.stringContaining("Appeal Brief") } },
    });
    expect(result.receipt).toMatchObject({ workProduct: { id: "authorities-1", revision: 4 },
      authorities: expect.arrayContaining([
        expect.objectContaining({ id: "article", excluded: true,
          evidenceIds: ["receipt-commentary"],
          locators: [{ kind: "page", label: "8" }],
          source: { kind: "resolved" }, sourceIdentity: { provider: "journal",
            stableSourceId: "article-1", version: "2024-01",
            sourceSha256: "a".repeat(64), externalUrl: "https://example.test/article" } }),
        expect.objectContaining({ id: "fca", binding: { kind: "document",
          documentId: "law-document",
          version: { versionId: "law-v3", sha256: sha256(legislationPdf) } } }),
      ]) });
    for (const role of ["table", "book"] as const) {
      expect(result.receipt.outputs[role]?.sha256).toBe(result.artifacts[role]?.sha256);
    }

    const docx = await JSZip.loadAsync(result.artifacts.table!.bytes);
    const documentXml = await docx.file("word/document.xml")!.async("string");
    const relations = await docx.file("word/_rels/document.xml.rels")!.async("string");
    expect(documentXml).toContain("Table of Authorities");
    expect(documentXml).toContain("Cases");
    expect(documentXml).toContain("Legislation");
    expect(documentXml).toContain("Secondary sources");
    expect(documentXml).toContain("R v Grant, 2009 SCC 32");
    expect(documentXml).toContain("Federal Courts Act, RSC 1985, c F-7");
    expect(documentXml).toContain("3, 5");
    expect(documentXml).toContain(">7<");
    expect(documentXml).not.toContain("¶ 12");
    expect(documentXml).not.toContain("fn 7");
    expect(documentXml).toContain("Not reproduced");
    expect(documentXml.indexOf("Cases")).toBeLessThan(documentXml.indexOf("Legislation"));
    expect(documentXml.indexOf("Legislation")).toBeLessThan(
      documentXml.indexOf("Secondary sources"));
    expect(relations).toContain("https://example.test/article");

    const book = await PDFDocument.load(result.artifacts.book!.bytes);
    expect(book.getPageCount()).toBe(5);
    expect(book.getTitle()).toBe("Book of Authorities");
    expect(book.getPage(2).getSize()).toEqual({ width: 400, height: 500 });
    expect(pageContent(book, book.getPage(2)).toUpperCase()).toContain(
      Buffer.from("Recognized scanned decision", "latin1").toString("hex").toUpperCase(),
    );
    expect(book.getPage(3).getSize()).toEqual({ width: 500, height: 600 });
    expect(book.getPage(4).getSize()).toEqual({ width: 500, height: 600 });
    expect(book.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(2);
    const outlines = book.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    expect(outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBeGreaterThan(4);
    expect(book.catalog.get(PDFName.of("PageMode"))).toEqual(PDFName.of("UseOutlines"));

    const rebuilt = await buildAuthorities(input);
    expect(rebuilt.artifacts.book?.sha256).toBe(result.artifacts.book?.sha256);
    expect(rebuilt.artifacts.table?.receipt.settings.settingsSha256)
      .toBe(result.artifacts.table?.receipt.settings.settingsSha256);
    expect(rebuilt.artifacts.book?.receipt.settings.settingsSha256)
      .toBe(result.artifacts.book?.receipt.settings.settingsSha256);
    const reordered = await buildAuthorities({ ...input,
      draft: Object.fromEntries(Object.entries(input.draft).reverse()) as AuthoritiesDraft });
    expect(reordered.artifacts.table?.receipt.settings.stateSha256)
      .toBe(result.artifacts.table?.receipt.settings.stateSha256);
    expect(reordered.artifacts.table?.receipt.settings.settingsSha256)
      .toBe(result.artifacts.table?.receipt.settings.settingsSha256);
    const renamed = await buildAuthorities({ ...input, title: "Renamed authorities" });
    expect(renamed.artifacts.table?.receipt.settings.settingsSha256)
      .not.toBe(result.artifacts.table?.receipt.settings.settingsSha256);
  });

  it("builds a table without source bytes and rejects a changed attached PDF for a book", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600]]);
    const tableDraft = { ...draft(casePdf, legislationPdf), outputMode: "table" as const };
    const table = await buildAuthorities({ draft: tableDraft, title: "Unsafe: name. ",
      workProduct: { id: "authorities-2", revision: 1 } });
    expect(Object.keys(table.artifacts)).toEqual(["table"]);
    expect(table.artifacts.table?.filename).toBe("Unsafe- name.table-of-authorities.docx");

    const bookDraft = { ...tableDraft, outputMode: "book" as const };
    await expect(buildAuthorities({ draft: bookDraft, title: "Book",
      workProduct: { id: "authorities-2", revision: 2 },
      sources: { "source:grant": { bytes: casePdf },
        "source:fca": { bytes: Buffer.from("changed") } } }))
      .rejects.toThrow("Attached PDF changed for Federal Courts Act, RSC 1985, c F-7");

    const invalid = Buffer.from("not a PDF"), invalidDraft = draft(casePdf, invalid);
    invalidDraft.outputMode = "book";
    await expect(buildAuthorities({ draft: invalidDraft, title: "Book",
      workProduct: { id: "authorities-2", revision: 3 },
      sources: { "source:grant": { bytes: casePdf }, "source:fca": { bytes: invalid } } }))
      .rejects.toThrow("Attached PDF could not be opened for Federal Courts Act, RSC 1985, c F-7");
  });

  it("emits a versionable copy of an imported DOCX with native TA and TOA fields", async () => {
    const citation = "R v Grant, 2009 SCC 32";
    const source = await Packer.toBuffer(new WordDocument({ sections: [{ children: [
      new Paragraph({ children: [new TextRun(citation)] }),
    ] }] }));
    const digest = sha256(source);
    const imported = { kind: "document" as const, bindingRole: "source" as const,
      filename: "Factum.docx", fileType: "docx" as const,
      snapshot: { documentId: "factum", versionId: "v3", sha256: digest } };
    const direct = createAuthoritiesDraft(imported, { source: { kind: "document",
      documentId: "factum", version: { versionId: "v3", sha256: digest } } });
    Object.assign(direct, { outputMode: "table", insertIntoDocument: true,
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [], text: citation, occurrenceIds: ["grant:0"] }],
      occurrences: { "grant:0": { id: "grant:0", unitId: "body:0", start: 0,
        end: citation.length, text: citation, kind: "case", citation,
        authorityId: "grant", reference: null, pinpoints: [], evidenceIds: [],
        sourceTextSha256: sha256(citation), localOrdinal: 0, reviewed: true } },
      authorities: { grant: { id: "grant", key: "grant", kind: "case", citation,
        name: "R v Grant", displayName: null, evidenceIds: [], locators: [],
        sourceIdentity: null,
        excluded: false, source: { kind: "unresolved" } } }, authorityOrder: ["grant"] });
    const result = await buildAuthorities({ draft: direct, title: "Factum",
      workProduct: { id: "authorities-docx", revision: 2 }, sources: { source: {
        bytes: source, resolved: { kind: "document", documentId: "factum",
          versionId: "v3", filename: "Factum.docx", sha256: digest },
      } } });

    expect(Object.keys(result.artifacts).sort()).toEqual(["annotated-document", "table"]);
    expect(result.artifacts["annotated-document"]).toMatchObject({ role: "annotated-document",
      filename: "Factum.with-table-of-authorities.docx", pageCount: null,
      receipt: { inputs: [{ role: "source", resolved: expect.objectContaining({
        documentId: "factum", versionId: "v3", sha256: digest }) }],
      output: { role: "annotated-document" } } });
    const zip = await JSZip.loadAsync(result.artifacts["annotated-document"]!.bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain(' TA \\l &quot;R v Grant, 2009 SCC 32&quot;');
    expect(xml).toContain(' TOA \\h \\e &quot;\\t&quot; ');
    expect(result.receipt.outputs["annotated-document"]?.sha256)
      .toBe(result.artifacts["annotated-document"]?.sha256);

    direct.occurrences["grant:0"].reviewed = false;
    const unchecked = await buildAuthorities({ draft: direct, title: "Factum",
      workProduct: { id: "authorities-docx", revision: 3 }, sources: { source: {
        bytes: source, resolved: { kind: "document", documentId: "factum",
          versionId: "v3", filename: "Factum.docx", sha256: digest },
      } } });
    const uncheckedXml = await (await JSZip.loadAsync(
      unchecked.artifacts["annotated-document"]!.bytes)).file("word/document.xml")!.async("string");
    expect(uncheckedXml).not.toContain(" TA \\l ");
  });
});
