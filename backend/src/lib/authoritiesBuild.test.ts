import { resolvePdfPagination } from "./pdfPagination";
import JSZip from "jszip";
import { Document as WordDocument, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName,
  PDFNumber, PDFRawStream, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { authoritiesTextRoles, authorityFilingTargets, authorityPassageRequests, authorityPassageTargets,
  buildAuthorities, renderAuthoritySourcePdf } from "./authoritiesBuild";
import { createAuthoritiesDraft, reduceAuthoritiesDraft, type AuthoritiesDraft,
  type AuthorityIdentity } from "./authoritiesDomain";
import { sha256 } from "./hash";
import { fit, renderAuthoritiesBook } from "./authoritiesBook";
import { filingLinkUrl } from "./authoritiesFinalPdf";
import { createAuthoritiesPreparation } from "./authoritiesPreparation";
import type { NativePdfPassageGeometry } from "./structureNative";
import { pdfAssembly } from "./pdfAssembly";
import * as pdfLibrary from "pdf-lib";

async function sourcePdf(label: string, sizes: Array<[number, number]>) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([width, height], index) => {
    const page = pdf.addPage([width, height]);
    page.drawText(`${label} page ${index + 1}`, { x: 36, y: height - 50, font, size: 14 });
  });
  return Buffer.from(await pdf.save());
}

async function withDecimalPageLabels(bytes: Uint8Array, start: number) {
  const pdf = await PDFDocument.load(bytes);
  pdf.catalog.set(PDFName.of("PageLabels"), pdf.context.register(pdf.context.obj({
    Nums: [0, pdf.context.obj({ S: "D", St: start })],
  })));
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

const pdfTextHex = (value: string) => Buffer.from(value
  .replace(/\u2013/gu, "\x96").replace(/\u2014/gu, "\x97"), "latin1")
  .toString("hex").toUpperCase();

const pageHasRgb = (content: string, wanted: readonly number[]) =>
  [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/gu)].some((match) =>
    wanted.every((value, index) => Math.abs(Number(match[index + 1]) - value) < .000_01));

function pageAnnots(document: PDFDocument, pageIndex: number) {
  const annots = document.getPage(pageIndex).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return [];
  return annots.asArray().map((ref) => document.context.lookup(ref, PDFDict));
}

const annotSubtypes = (document: PDFDocument, pageIndex: number) =>
  pageAnnots(document, pageIndex).map((annot) => String(annot.lookup(PDFName.of("Subtype"))));

const annotContents = (document: PDFDocument, pageIndex: number) =>
  pageAnnots(document, pageIndex).map((annot) => {
    const contents = annot.lookupMaybe(PDFName.of("Contents"), PDFHexString);
    return contents?.decodeText() ?? "";
  });

function generatedTextLayout(content: string) {
  return {
    fonts: [...content.matchAll(/\/([^\s]+)\s+[\d.]+\s+Tf/gu)].map((match) => match[1]),
    sizes: [...content.matchAll(/([\d.]+)\s+Tf/gu)].map((match) => Number(match[1])),
    positions: [...content.matchAll(/1\s+0\s+0\s+1\s+([\d.]+)\s+([\d.]+)\s+Tm/gu)]
      .map((match) => [Number(match[1]), Number(match[2])]),
  };
}

function attached(
  id: string, kind: AuthorityIdentity["kind"], citation: string, name: string,
  bindingRole: string, bytes: Uint8Array, language: "en" | "fr" | "bilingual" = "en",
): AuthorityIdentity {
  return { id, key: `${kind}:${id}`, kind, citation, name, displayName: null,
    evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
    source: { kind: "attached", sources: [{ bindingRole,
      filename: `${id}.pdf`, sourceSha256: sha256(bytes), sourceUrl: null,
      origin: "manual", language }] } };
}

const FORM_66_COVER = { courtFileNumber: "T-123-26", partyGroups: [
  { role: "Applicant", parties: ["North Prairie Ltd."] },
  { role: "Respondent", parties: ["Attorney General of Canada"] },
], applicationUnder: "Federal Courts Act, section 18.1", title: "" };
const withForm66 = (state: AuthoritiesDraft) => {
  state.cover = structuredClone(FORM_66_COVER); return state;
};

function finalDraft(brief: Uint8Array, original: Uint8Array) {
  const state = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
    filename: "Brief.pdf", fileType: "pdf", snapshot: null }, {
    source: { kind: "local-file", handleId: "brief", lastSeen: { name: "Brief.pdf",
      size: brief.length, modified: 1, sha256: sha256(brief) } },
  }, "book");
  state.bindings.original = { kind: "local-file", handleId: "original", lastSeen: { name: "Grant.pdf",
    size: original.length, modified: 1, sha256: sha256(original) } };
  const citation = "2009 SCC 32", text = `${citation} at para 12`;
  state.authorities.grant = attached("grant", "case", citation, "R v Grant", "original", original);
  state.authorityOrder = ["grant"];
  state.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
    footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["grant:0"] }];
  state.occurrences["grant:0"] = { id: "grant:0", unitId: "body:0", start: 0, end: text.length,
    text, authoritySpan: { start: 0, end: citation.length, text: citation },
    coreSpan: { start: 0, end: citation.length, text: citation },
    pinpointSpan: { start: text.indexOf("para 12"), end: text.length, text: "para 12" },
    kind: "case", citation, authorityId: "grant", reference: null,
    pinpoints: [{ kind: "paragraph", text: "12" }], evidenceIds: [],
    sourceTextSha256: sha256(text), localOrdinal: 0, reviewed: true };
  Object.assign(state.settings, { finalPdf: true, linkTabs: true, linkPinpoints: true, passageMarking: "none" });
  return state;
}

const paragraphGeometry = (bytes: Uint8Array, status: "found" | "ambiguous" = "found"): NativePdfPassageGeometry => ({
  schemaVersion: "legalpdf.passage-geometry.v1", sourceSha256: sha256(bytes), parserVersion: "test-fixture",
  coordinateSpace: "visible_crop_box", coordinateOrigin: "top_left", rotationApplied: true,
  targets: [{ id: "paragraph:12", locatorKind: "paragraph", locator: "12", status, printed: status === "found",
    pages: status === "found" ? [{ pageNumber: 2, width: 400, height: 500,
      source: "native", passageRects: [[36, 60, 320, 90]], text: "[12] Relevant paragraph." }] : [], quotes: [] }],
});

describe("Authorities final export", () => {
  async function linkedBrief() {
    const document = await PDFDocument.create(), page = document.addPage([612, 792]);
    const font = await document.embedFont(StandardFonts.TimesRoman);
    page.drawText("2009 SCC 32 at para 12 [Tab 1]", { x: 36, y: 700, font, size: 12 });
    for (const [kind, rect] of [["tab", [190, 696, 240, 712]], ["pinpoint", [120, 696, 185, 712]]] as const)
      page.node.addAnnot(document.context.register(document.context.obj({ Type: "Annot", Subtype: "Link",
        Rect: [...rect], Border: [0, 0, 0], A: { S: "URI", URI: PDFHexString.fromText(filingLinkUrl(kind, "grant:0")) } })));
    page.node.addAnnot(document.context.register(document.context.obj({ Type: "Annot", Subtype: "Link",
      Rect: [36, 50, 150, 65], A: { S: "URI", URI: PDFHexString.fromText("https://example.test/original-link") } })));
    return Buffer.from(await document.save());
  }

  it("combines the brief and book with exact tab and pinpoint targets and rebound book index links", async () => {
    const brief = await linkedBrief(), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const state = finalDraft(brief, original);
    const result = await buildAuthorities({ draft: state, title: "Appeal", workProduct: { id: "final", revision: 1 },
      sources: { source: { bytes: brief }, original: { bytes: original, passageGeometry: paragraphGeometry(original) } } });
    expect(Object.keys(result.artifacts).sort()).toEqual(["book", "final-pdf"]);
    expect(result.receipt.linkWarnings).toEqual([]);
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    expect(combined.getPageCount()).toBe(5);
    expect(combined.getPage(3).getSize()).toEqual({ width: 400, height: 500 });
    const links = pageAnnots(combined, 0);
    const internal = links.filter((annotation) => annotation.has(PDFName.of("Dest")));
    expect(internal).toHaveLength(2);
    const destinations = internal.map((annotation) => annotation.lookup(PDFName.of("Dest"), PDFArray));
    expect(String(destinations[0].get(0))).toBe(String(combined.getPage(3).ref));
    expect(String(destinations[1].get(0))).toBe(String(combined.getPage(4).ref));
    expect(String(destinations[1].get(1))).toBe("/XYZ");
    expect(destinations[1].lookup(3, PDFNumber).asNumber()).toBe(440);
    const originalLink = links.find((annotation) => annotation.has(PDFName.of("A")))!;
    expect(originalLink.lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI"), PDFHexString).decodeText())
      .toBe("https://example.test/original-link");
    const tocLink = pageAnnots(combined, 2).find((annotation) => annotation.has(PDFName.of("Dest")))!;
    expect(String(tocLink.lookup(PDFName.of("Dest"), PDFArray).get(0)))
      .toBe(String(combined.getPage(3).ref));
    const root = combined.catalog.lookup(PDFName.of("Outlines"), PDFDict).lookup(PDFName.of("First"), PDFDict);
    expect(root.lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe("Brief");
    const book = root.lookup(PDFName.of("Next"), PDFDict);
    expect(book.lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe("Book of authorities");
    expect(String(book.lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(combined.getPage(1).ref));
  });

  it("abstains from ambiguous manual pinpoints and supplies a concise manual-link report", async () => {
    const brief = await linkedBrief(), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const state = finalDraft(brief, original);
    const result = await buildAuthorities({ draft: state, title: "Appeal", workProduct: { id: "ambiguous", revision: 1 },
      sources: { source: { bytes: brief }, original: { bytes: original, passageGeometry: paragraphGeometry(original, "ambiguous") } } });
    expect(result.receipt.linkWarnings).toEqual([{ occurrenceId: "grant:0", citation: "2009 SCC 32",
      pinpoint: "para 12", tab: "Tab 1", reason: "pinpoint-ambiguous" }]);
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    expect(pageAnnots(combined, 0).filter((annotation) => annotation.has(PDFName.of("Dest")))).toHaveLength(1);
    expect(result.artifacts["link-report"]!.bytes.toString()).toContain("1 link wasn't added. Add it in a PDF editor.");
    expect(result.artifacts["link-report"]!.bytes.toString()).toContain("2009 SCC 32 — para 12 [Tab 1]: Pinpoint is ambiguous.");
    expect(result.artifacts["link-report"]!.bytes.toString()).not.toContain("source PDF page");
    state.settings.linkTabs = false; state.settings.linkPinpoints = false;
    const plain = await buildAuthorities({ draft: state, title: "Plain", workProduct: { id: "plain", revision: 1 },
      sources: { source: { bytes: brief }, original: { bytes: original } } });
    expect(plain.receipt.linkWarnings).toBeUndefined();
    expect(plain.artifacts["link-report"]).toBeUndefined();
  });

  it("does not link an inferred paragraph number to unnumbered source prose", async () => {
    const brief = await linkedBrief(), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const state = finalDraft(brief, original), geometry = paragraphGeometry(original);
    geometry.targets[0].pages[0].text = "Fixture judgment / public synthetic";
    geometry.targets[0].printed = false;
    const result = await buildAuthorities({ draft: state, title: "Unnumbered source",
      workProduct: { id: "unnumbered", revision: 1 }, sources: {
        source: { bytes: brief }, original: { bytes: original, passageGeometry: geometry },
      } });
    expect(result.receipt.linkWarnings).toEqual([{ occurrenceId: "grant:0", citation: "2009 SCC 32",
      pinpoint: "para 12", tab: "Tab 1", reason: "pinpoint-unlocated" }]);
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    const links = pageAnnots(combined, 0).filter((annotation) => annotation.has(PDFName.of("Dest")));
    expect(links).toHaveLength(1);
    expect(String(links[0].lookup(PDFName.of("Dest"), PDFArray).get(1))).toBe("/Fit");
  });

  it("abstains from duplicate filing text while retaining verified target pages in the report", async () => {
    const brief = await sourcePdf("2009 SCC 32 at para 12 repeated", [[612, 792]]);
    const original = await sourcePdf("Original", [[400, 500], [400, 500]]), state = finalDraft(brief, original);
    const geometry: NativePdfPassageGeometry = { ...paragraphGeometry(brief), targets: [{ id: "filing:grant:0",
      locatorKind: "page", locator: "1", status: "found", pages: [], quotes: [
        { text: "2009 SCC 32", status: "ambiguous", rects: [] },
        { text: "para 12", status: "ambiguous", rects: [] },
      ] }] };
    const result = await buildAuthorities({ draft: state, title: "Duplicate", workProduct: { id: "duplicate", revision: 1 },
      sources: { source: { bytes: brief, passageGeometry: geometry },
        original: { bytes: original, passageGeometry: paragraphGeometry(original) } } });
    expect(result.receipt.linkWarnings).toHaveLength(2);
    expect(result.receipt.linkWarnings!.find(({ pinpoint }) => pinpoint !== null))
      .toMatchObject({ reason: "citation-location", sourcePageNumber: 2 });
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    expect(pageAnnots(combined, 0)).toEqual([]);
    expect(result.artifacts["link-report"]!.bytes.toString()).toContain("source PDF page 2");
  });

  it("links existing PDF tab text and pinpoints using verified native quote geometry", async () => {
    const brief = await sourcePdf("2009 SCC 32 at para 12 [Tab 1]", [[612, 792]]);
    const original = await sourcePdf("Original", [[400, 500], [400, 500]]), state = finalDraft(brief, original);
    state.units[0].text += " [Tab 1]";
    const filingGeometry: NativePdfPassageGeometry = { ...paragraphGeometry(brief), targets: [{ id: "filing:grant:0",
      locatorKind: "page", locator: "1", status: "found", pages: [{ pageNumber: 1, width: 612, height: 792,
        source: "native", passageRects: [[36, 50, 300, 80]] }], quotes: [
        { text: "[Tab 1]", status: "found", pageNumber: 1, rects: [[190, 60, 240, 80]] },
        { text: "para 12", status: "found", pageNumber: 1, rects: [[120, 60, 185, 80]] },
      ] }] };
    const result = await buildAuthorities({ draft: state, title: "Existing PDF", workProduct: { id: "native-geometry", revision: 1 },
      sources: { source: { bytes: brief, passageGeometry: filingGeometry },
        original: { bytes: original, passageGeometry: paragraphGeometry(original) } } });
    expect(result.receipt.linkWarnings).toEqual([]);
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes), links = pageAnnots(combined, 0);
    expect(links).toHaveLength(2);
    expect(links[0].lookup(PDFName.of("Rect"), PDFArray).asArray().map((value) => (value as PDFNumber).asNumber()))
      .toEqual([190, 712, 240, 732]);
    expect(String(links[0].lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(combined.getPage(3).ref));
    expect(String(links[1].lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(combined.getPage(4).ref));
  });

  it("leaves the brief's own web link where it is, and reports the link it would have covered", async () => {
    const plain = await PDFDocument.load(await sourcePdf("2009 SCC 32 at para 12 [Tab 1]", [[612, 792]]));
    plain.getPage(0).node.addAnnot(plain.context.register(plain.context.obj({ Type: "Annot", Subtype: "Link",
      Rect: [110, 708, 190, 736], A: { S: "URI", URI: PDFHexString.fromText("https://example.test/grant-para-12") } })));
    const brief = Buffer.from(await plain.save()), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const state = finalDraft(brief, original);
    state.units[0].text += " [Tab 1]";
    const filingGeometry: NativePdfPassageGeometry = { ...paragraphGeometry(brief), targets: [{ id: "filing:grant:0",
      locatorKind: "page", locator: "1", status: "found", pages: [{ pageNumber: 1, width: 612, height: 792,
        source: "native", passageRects: [[36, 50, 300, 80]] }], quotes: [
        { text: "[Tab 1]", status: "found", pageNumber: 1, rects: [[190, 60, 240, 80]] },
        { text: "para 12", status: "found", pageNumber: 1, rects: [[120, 60, 185, 80]] },
      ] }] };
    const result = await buildAuthorities({ draft: state, title: "Web link", workProduct: { id: "web-link", revision: 1 },
      sources: { source: { bytes: brief, passageGeometry: filingGeometry },
        original: { bytes: original, passageGeometry: paragraphGeometry(original) } } });
    expect(result.receipt.linkWarnings).toEqual([{ occurrenceId: "grant:0", citation: "2009 SCC 32", pinpoint: "para 12",
      tab: "Tab 1", reason: "web-link" }]);
    const links = pageAnnots(await PDFDocument.load(result.artifacts["final-pdf"]!.bytes), 0);
    expect(links.map((link) => link.has(PDFName.of("Dest")) ? "tab" : link.lookup(PDFName.of("A"), PDFDict)
      .lookup(PDFName.of("URI"), PDFHexString).decodeText())).toEqual(["https://example.test/grant-para-12", "tab"]);
    expect(result.artifacts["link-report"]!.bytes.toString()).toContain("The brief already links it to a web page");
  });

  it("keeps tab and pinpoint links correct when the book is split across volumes", async () => {
    const brief = await linkedBrief(), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const state = finalDraft(brief, original);
    const result = await buildAuthorities({ draft: state, title: "Volumes", workProduct: { id: "volumes", revision: 1 },
      sources: { source: { bytes: brief }, original: { bytes: original, passageGeometry: paragraphGeometry(original) } } },
    async (plan, signal) => (await renderAuthoritiesBook(pdfLibrary, { ...plan,
      limits: { maxPages: 3, maxBytes: 1024 * 1024 } }, signal)).map((book) => ({
      role: book.role, filename: book.filename, mimeType: book.mimeType, bytes: Buffer.from(book.bytes),
      pageCount: book.pageCount, sha256: sha256(book.bytes), bookPlacements: book.placements,
    })));
    expect(Object.keys(result.artifacts).sort()).toEqual(["book", "book-2", "final-pdf"]);
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    expect(combined.getPageCount()).toBe(7);
    const links = pageAnnots(combined, 0).filter((annotation) => annotation.has(PDFName.of("Dest")));
    expect(String(links[0].lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(combined.getPage(3).ref));
    expect(String(links[1].lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(combined.getPage(6).ref));
    for (const [toc, target] of [[2, 3], [5, 6]]) {
      const link = pageAnnots(combined, toc).find((annotation) => annotation.has(PDFName.of("Dest")))!;
      expect(String(link.lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(combined.getPage(target).ref));
    }
  });

  it("keeps missing latest authority slots as labelled stubs and refuses altered source bytes", async () => {
    const brief = await linkedBrief(), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const state = finalDraft(brief, original);
    state.settings.allowIncomplete = true;
    state.bindings.original = { kind: "document", documentId: "deleted", version: "latest" };
    const result = await buildAuthorities({ draft: state, title: "Missing", workProduct: { id: "missing-final", revision: 1 },
      sources: { source: { bytes: brief } } });
    expect(result.receipt.inputs.map(({ role }) => role)).toEqual(["source"]);
    expect(result.receipt.authorities[0]).toMatchObject({ tab: "Tab 1", source: { kind: "attached" } });
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    expect(combined.getPageCount()).toBe(4);
    expect(combined.getTitle()).toContain("DRAFT");
    expect(pageContent(combined, combined.getPage(3)).toUpperCase()).toContain(pdfTextHex("Source PDF unavailable"));
    await expect(buildAuthorities({ draft: state, title: "Changed", workProduct: { id: "changed", revision: 1 },
      sources: { source: { bytes: original } } })).rejects.toThrow(/changed/iu);
  });

  it("links a Word brief's final PDF through a PDF the user saved from Word", async () => {
    const lines = ["Standing is settled by 2009 SCC 32 at para 12 for this appeal.",
      "Later the panel relied on 2009 SCC 32 at para 12 [Tab 1] again."];
    const savedBrief = async (pages: string[]) => {
      const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.TimesRoman);
      for (const text of pages) document.addPage([612, 792]).drawText(text, { x: 72, y: 700, font, size: 12 });
      return Buffer.from(await document.save());
    };
    const brief = await savedBrief(lines), original = await sourcePdf("Original", [[400, 500], [400, 500]]);
    const citation = "2009 SCC 32 at para 12", stray = "2009 SCC 32 at para 14";
    const texts = [lines[0], lines[1].replace(" [Tab 1]", ""), `Compare ${stray}.`];
    // The tab references come in a Word copy, which the user saved as this PDF.
    const word = await Packer.toBuffer(new WordDocument({ sections: [{ children: texts.map((text) => new Paragraph(text)) }] }));
    const state = finalDraft(word, original);
    if (state.import.kind !== "document") throw new Error("Invalid fixture");
    Object.assign(state.import, { fileType: "docx", filename: "Appeal brief.docx" });
    state.settings.citationSuffix = "tab";
    state.units = texts.map((text, index) => ({
      id: `body:${index}`, kind: index === 2 ? "footnote" as const : "body" as const, ordinal: index,
      footnoteId: index === 2 ? 1 : null, footnoteRefs: [], pageNumbers: [], text, occurrenceIds: [`grant:${index}`] }));
    state.units.forEach((unit, index) => {
      const quoted = index === 2 ? stray : citation, start = unit.text.indexOf(quoted), end = start + quoted.length;
      state.occurrences[`grant:${index}`] = { ...state.occurrences["grant:0"], id: `grant:${index}`, unitId: unit.id,
        start, end, text: quoted, authoritySpan: { start, end: start + 11, text: "2009 SCC 32" },
        coreSpan: { start, end: start + 11, text: "2009 SCC 32" },
        pinpointSpan: { start: end - 7, end, text: quoted.slice(-7) },
        pinpoints: [{ kind: "paragraph", text: quoted.slice(-2) }] };
    });
    const build = (sources: NonNullable<Parameters<typeof buildAuthorities>[0]["sources"]>) => buildAuthorities({
      draft: state, title: "Appeal", workProduct: { id: "brief-pdf", revision: 1 }, sources: {
        source: { bytes: word }, original: { bytes: original, passageGeometry: paragraphGeometry(original) }, ...sources } });
    // Until the brief PDF is added, everything else builds and the final PDF waits for it.
    expect(Object.keys((await build({})).artifacts).sort()).toEqual(["annotated-document", "book"]);
    const attach = async (bytes: Buffer) => {
      state.bookParts.brief = { bindingRole: "brief", filename: "Appeal brief.pdf", sourceSha256: sha256(bytes) };
      state.bindings.brief = { kind: "local-file", handleId: "brief", lastSeen: { name: "Appeal brief.pdf",
        size: bytes.length, modified: 1, sha256: sha256(bytes) } };
      expect(authoritiesTextRoles(state).has("brief")).toBe(true);
      return { brief: { bytes, ...await createAuthoritiesPreparation(state).prepareText("brief", { bytes }) } };
    };
    const other = await savedBrief(["An unrelated memorandum about costs."]);
    await expect(build(await attach(other))).rejects.toThrow(/doesn't match this brief: 0 of 3 citations/u);

    const prepared = await attach(brief);
    expect(prepared.brief.passageGeometry?.targets.map(({ id, locator }) => [id, locator]))
      .toEqual([["filing:grant:0", "1"], ["filing:grant:1", "2"]]);
    const result = await build(prepared);
    expect(result.receipt.inputs.map(({ role }) => role)).toContain("brief");
    const combined = await PDFDocument.load(result.artifacts["final-pdf"]!.bytes);
    expect(combined.getPageCount()).toBe(6);
    const links = [0, 1].map((page) => pageAnnots(combined, page).map((annotation) => ({
      x: annotation.lookup(PDFName.of("Rect"), PDFArray).lookup(0, PDFNumber).asNumber(),
      dest: annotation.lookup(PDFName.of("Dest"), PDFArray) })));
    for (const page of links) {
      expect(page.map(({ dest }) => String(dest.get(0)))).toEqual([String(combined.getPage(4).ref), String(combined.getPage(5).ref)]);
      expect(page.map(({ dest }) => String(dest.get(1)))).toEqual(["/Fit", "/XYZ"]);
    }
    // The saved Word output's "[Tab 1]" carries its tab link; a plain citation carries its own.
    expect(links[1][0].x).toBeGreaterThan(links[1][1].x);
    expect(links[0][0].x).toBeLessThan(links[0][1].x);
    expect(result.receipt.linkWarnings).toEqual([
      { occurrenceId: "grant:2", citation: "2009 SCC 32", pinpoint: null, tab: "Tab 1", reason: "citation-location" },
      { occurrenceId: "grant:2", citation: "2009 SCC 32", pinpoint: "para 14", tab: "Tab 1", reason: "citation-location" },
    ]);
    expect(result.artifacts["link-report"]!.bytes.toString()).toContain("2009 SCC 32 — para 14 [Tab 1]");
  });

  it("marks Word citations and references with the current tab while keeping excluded citations untouched", async () => {
    const body = "2009 SCC 32 at para 12", note = "Ibid at para 13", excluded = "2020 SCC 1";
    const word = await Packer.toBuffer(new WordDocument({ footnotes: { 7: { children: [new Paragraph(note)] } },
      sections: [{ children: [new Paragraph({ children: [new TextRun(body), new FootnoteReferenceRun(7)] }), new Paragraph(excluded)] }] }));
    const original = await sourcePdf("Original", [[400, 500], [400, 500]]), state = finalDraft(word, original);
    if (state.import.kind !== "document") throw new Error("Invalid fixture");
    state.import.fileType = "docx"; state.import.filename = "Brief.docx";
    Object.assign(state.settings, { finalPdf: false, linkTabs: false, linkPinpoints: false,
      tableDelivery: "native-marks", citationSuffix: "custom", citationSuffixLabel: "Book of authorities Tab", tabStart: 3 });
    state.insertIntoDocument = true;
    state.authorities.excluded = { ...state.authorities.grant, id: "excluded", key: "excluded",
      citation: excluded, name: "Excluded", excluded: true, source: { kind: "unresolved" } };
    state.authorityOrder.unshift("excluded");
    state.units.push({ id: "body:1", kind: "body", ordinal: 1, footnoteId: null,
      footnoteRefs: [], pageNumbers: [], text: excluded, occurrenceIds: ["excluded:0"] },
    { id: "footnote:7", kind: "footnote", ordinal: 2, footnoteId: 7,
      footnoteRefs: [], pageNumbers: [], text: note, occurrenceIds: ["grant:ref"] });
    state.units[0].footnoteRefs = [[7, body.length]];
    const occurrence = state.occurrences["grant:0"];
    state.occurrences["excluded:0"] = { ...occurrence, id: "excluded:0", unitId: "body:1",
      start: 0, end: excluded.length, text: excluded, citation: excluded, authorityId: "excluded",
      authoritySpan: { start: 0, end: excluded.length, text: excluded },
      coreSpan: { start: 0, end: excluded.length, text: excluded }, pinpointSpan: null, pinpoints: [] };
    state.occurrences["grant:ref"] = { ...occurrence, id: "grant:ref", unitId: "footnote:7", kind: "reference",
      start: 0, end: note.length, text: note, citation: "Ibid",
      authoritySpan: { start: 0, end: 4, text: "Ibid" }, coreSpan: { start: 0, end: 4, text: "Ibid" },
      pinpointSpan: { start: note.indexOf("para 13"), end: note.length, text: "para 13" },
      reference: { kind: "ibid", targetAuthorityId: "grant" }, pinpoints: [{ kind: "paragraph", text: "13" }] };
    const build = () => buildAuthorities({ draft: state, title: "Word", workProduct: { id: "word-options", revision: 1 },
      sources: { source: { bytes: word }, original: { bytes: original } } });
    const marked = await build(), zip = await JSZip.loadAsync(marked.artifacts["annotated-document"]!.bytes);
    expect(Object.keys(marked.artifacts).sort()).toEqual(["annotated-document", "book"]);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml.match(/ TA /gu)).toHaveLength(1);
    expect(xml).not.toContain(" TOA ");
    expect(xml).toContain("[Book of authorities Tab 3]");
    expect(xml).not.toContain("[Book of authorities Not reproduced]");
    const notes = await zip.file("word/footnotes.xml")!.async("string");
    expect(notes).toContain("[Book of authorities Tab 3]"); expect(notes).toContain(" TA ");
    state.settings.tableDelivery = "native-append"; state.settings.citationSuffix = "tab";
    const table = await build(), tableXml = await (await JSZip.loadAsync(table.artifacts["annotated-document"]!.bytes))
      .file("word/document.xml")!.async("string");
    expect(tableXml).toContain(" TOA "); expect(tableXml).toContain("[Tab 3]");

    state.settings.finalPdf = true;
    const converted = await buildAuthorities({ draft: state, title: "Converted", workProduct: { id: "converted", revision: 1 },
      sources: { source: { bytes: word }, original: { bytes: original } }, finalPdfSource: async (bytes) => {
        const conversionXml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
        expect(conversionXml).toContain("TABLE OF AUTHORITIES");
        expect(conversionXml).toContain("R v Grant");
        expect(conversionXml).not.toContain(" TOA ");
        return sourcePdf("Converted brief and visible table", [[612, 792], [612, 792]]);
      } });
    expect(converted.artifacts["final-pdf"]?.pageCount).toBe(6);
    const retainedWord = await (await JSZip.loadAsync(converted.artifacts["annotated-document"]!.bytes))
      .file("word/document.xml")!.async("string");
    expect(retainedWord).toContain(" TA "); expect(retainedWord).toContain(" TOA ");
  });

  it("builds a Word copy from its marks and its tab references, each chosen apart from the other", async () => {
    const word = await Packer.toBuffer(new WordDocument({ sections: [{ children: [new Paragraph("2009 SCC 32 at para 12")] }] }));
    const original = await sourcePdf("Original", [[400, 500]]), state = finalDraft(word, original);
    if (state.import.kind !== "document") throw new Error("Invalid fixture");
    Object.assign(state.import, { fileType: "docx", filename: "Brief.docx" });
    Object.assign(state.settings, { finalPdf: false, linkTabs: false, linkPinpoints: false, tabStart: 4 });
    const label = "Appellant's Book of Authorities, Tab";
    const copies = { none: [false, "native-append"], marks: [true, "native-marks"], table: [true, "native-append"],
      linked: [true, "linked-append"] } as const;
    const tabs = { none: null, tab: "[Tab 4]", custom: `[${label} 4]` } as const;
    for (const [copy, [marked, tableDelivery]] of Object.entries(copies)) for (const [suffix, text] of Object.entries(tabs)) {
      Object.assign(state, { insertIntoDocument: marked });
      Object.assign(state.settings, { tableDelivery, citationSuffix: suffix, citationSuffixLabel: suffix === "custom" ? label : undefined });
      const built = await buildAuthorities({ draft: state, title: "Brief", workProduct: { id: `${copy}-${suffix}`, revision: 1 },
        sources: { source: { bytes: word }, original: { bytes: original } } });
      const output = built.artifacts["annotated-document"], at = `${copy} + ${suffix}`;
      expect(!!output, at).toBe(marked || !!text);
      if (!output) continue;
      expect(output.filename, at).toBe(`Brief.${!marked ? "with-tab-references"
        : tableDelivery === "native-marks" ? "marked-authorities" : "with-table-of-authorities"}.docx`);
      const zip = await JSZip.loadAsync(output.bytes), xml = await zip.file("word/document.xml")!.async("string");
      const visible = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(([, value]) => value).join("")
        .replace(/&apos;/gu, "'");
      expect(xml.match(/ TA \\l/gu)?.length ?? 0, at).toBe(marked && tableDelivery !== "linked-append" ? 1 : 0);
      expect(xml.includes(" TOA "), at).toBe(tableDelivery === "native-append" && marked);
      expect(visible.includes("TABLE OF AUTHORITIES"), at).toBe(tableDelivery === "linked-append" && marked);
      expect(visible.startsWith(`2009 SCC 32 at para 12${text ? ` ${text}` : ""}`), at).toBe(true);
      expect((visible.match(/\[[^\]]*4\]/gu) ?? []).length, at).toBe(text ? 1 : 0);
      // A copy with only tab references has no field for Word to refresh on opening.
      expect((await zip.file("word/settings.xml")!.async("string")).includes("w:updateFields"), at).toBe(marked);
      expect(built.receipt.outputs["annotated-document"]?.filename).toBe(output.filename);
    }
  });
});

function draft(
  casePdf: Uint8Array, legislationPdf: Uint8Array, imported = false,
): AuthoritiesDraft {
  const caseAuthority = attached("grant", "case", "2009 SCC 32", "R v Grant",
    "source:grant", casePdf);
  const legislation = attached("fca", "legislation", "RSC 1985, c F-7",
    "Federal Courts Act", "source:fca", legislationPdf, "bilingual");
  const commentary: AuthorityIdentity = { id: "article", key: "commentary:article",
    kind: "commentary", citation: "(2024) 10 Legal Rev 1", name: "Useful article",
    displayName: null, evidenceIds: ["receipt-commentary"],
    locators: [{ kind: "page", label: "8" }], excluded: true,
    sourceIdentity: { provider: "journal", stableSourceId: "article-1",
      sourceSha256: "a".repeat(64), version: "2024-01",
      externalUrl: "https://example.test/article" }, source: { kind: "resolved" } };
  const occurrences = {
    grant: { id: "grant", unitId: "body:1", start: 0, end: 11, text: "2009 SCC 32",
      authoritySpan: { start: 0, end: 11, text: "2009 SCC 32" },
      coreSpan: { start: 0, end: 11, text: "2009 SCC 32" }, pinpointSpan: null,
      kind: "case" as const, citation: "2009 SCC 32", authorityId: "grant", reference: null,
      pinpoints: [{ kind: "paragraph" as const, text: "12" }], evidenceIds: ["evidence-1"],
      sourceTextSha256: "body-sha", localOrdinal: 0, reviewed: true },
    fca: { id: "fca", unitId: "footnote:7", start: 0, end: 17,
      text: "RSC 1985, c F-7", kind: "legislation" as const,
      authoritySpan: { start: 0, end: 17, text: "RSC 1985, c F-7" },
      coreSpan: { start: 0, end: 17, text: "RSC 1985, c F-7" }, pinpointSpan: null,
      citation: "RSC 1985, c F-7", authorityId: "fca", reference: null, pinpoints: [],
      evidenceIds: [], sourceTextSha256: "footnote-sha", localOrdinal: 0, reviewed: true },
    article: { id: "article", unitId: "body:2", start: 0, end: 26,
      text: "(2024) 10 Legal Rev 1 note", kind: "commentary" as const,
      authoritySpan: { start: 0, end: 21, text: "(2024) 10 Legal Rev 1" },
      coreSpan: { start: 0, end: 21, text: "(2024) 10 Legal Rev 1" },
      pinpointSpan: { start: 22, end: 26, text: "note" },
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
    outputMode: "both", settings: createAuthoritiesDraft({ kind: "manual" }).settings,
    cover: structuredClone(FORM_66_COVER),
    bookParts: { cover: null, index: null, supplements: [] },
    insertIntoDocument: false, ledger: null,
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
  it("renders reconstructed Markdown as styled searchable text without losing literal characters", async () => {
    const bytes = await renderAuthoritySourcePdf({ kind: "legislation", name: "Example Act",
      citation: "SC 2026, c 1", date: null, sourceUrl: null,
      text: "## Interpretation\n\n**Defined term** means *a person* and ***both styles***.\n\n" +
        "> Quoted provision\n\n7. First item\n8. Second item\n\n" +
        "[Official source](https://example.test/law) and `section_id` with escaped \\*literal\\*.\n\n" +
        "| Term | Meaning |\n| --- | --- |\n| Act | This Act |" });
    const document = await PDFDocument.load(bytes), page = document.getPage(0);
    const content = pageContent(document, page);
    const text = [...content.matchAll(/<([\dA-F]+)>\s*Tj/giu)]
      .map(match => Buffer.from(match[1], "hex").toString("latin1")).join("");
    expect(text).toContain("Defined term means a person and both styles.");
    expect(text).toContain("7. First item");
    expect(text).toContain("8. Second item");
    expect(text).toContain("Official source and section_id with escaped *literal*.");
    expect(text).not.toMatch(/##|\*\*|https:\/\/|\[Official|---/u);
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const fontFor = (value: string) => {
      const name = new RegExp(`/([^\\s]+) [\\d.]+ Tf\\s+[\\s\\S]*?<${pdfTextHex(value)}> Tj`, "u");
      // Each drawText has its own graphics state; inspect the run containing this text.
      const operation = content.split(/\bq\b/u).find(part => part.includes(`<${pdfTextHex(value)}> Tj`))!;
      const match = operation.match(name)!;
      return fonts.lookup(PDFName.of(match[1]), PDFDict).lookup(PDFName.of("BaseFont")).toString();
    };
    expect(fontFor("Defined term")).toBe("/Times-Bold");
    expect(fontFor("a person")).toBe("/Times-Italic");
    expect(fontFor("both styles")).toBe("/Times-BoldItalic");
    expect(fontFor("section_id")).toBe("/Courier");
  });

  it("renders publisher text containing Unicode punctuation and multiline titles", async () => {
    const bytes = await renderAuthoritySourcePdf({ kind: "case", name: "A ‑ B\r\nSecond\tline",
      citation: "2026 SCC 16", date: null, sourceUrl: null,
      text: "The Court said “source text” — not source metadata." });
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(1);
    const font = await document.embedFont(StandardFonts.Helvetica);
    expect(fit(font, "A ‑ B\r\nSecond\tline", 12, 400)).toBe("A - B Second line");
  });

  it("gives reconstructed legislation an outline of its headings and sections", async () => {
    const bytes = await renderAuthoritySourcePdf({ kind: "legislation", name: "Harbour Dues Act",
      citation: "SC 2031, c 4", date: null, sourceUrl: null,
      text: "# Harbour Dues Act\n\n## Short Title\n\n**Short title**\n\n**1** This Act is the Harbour Dues Act.\n\n" +
        "## Dues\n\n**Dues payable**\n\n**2** (1) A vessel pays dues\n\n(a) on arrival, or\n\n(b) on departure.\n\n" +
        "**Waiver**\n\n(2) The harbour master may waive dues.\n\n**3** Dues are paid to the harbour authority." });
    const document = await PDFDocument.load(bytes);
    const outline = pdfAssembly(pdfLibrary).readOutlines(document);
    expect(outline.map(({ title, children }) => [title, children?.map(child => child.title)])).toEqual([
      ["Short Title", ["s 1 Short title"]], ["Dues", ["s 2 Dues payable", "s 3"]]]);
  });

  it("nests an authority's own bookmarks above its pinpoints under the tab", async () => {
    const source = await PDFDocument.load(await sourcePdf("Statute", [[400, 500], [400, 500], [400, 500]]));
    pdfAssembly(pdfLibrary).applyOutlines(source, [{ title: "Part 1 Ferries", pageIndex: 1,
      children: [{ title: "4 Fares", pageIndex: 2 }] }], false);
    const pdf = Buffer.from(await source.save());
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "legislation", "SC 2031, c 9", "Ferries Act", "item", pdf);
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf) } };
    const built = await buildAuthorities({ draft: state, title: "Authorities",
      workProduct: { id: "outline", revision: 1 }, sources: { item: { bytes: pdf } } });
    const book = await PDFDocument.load(built.artifacts.book!.bytes);
    const tab = pdfAssembly(pdfLibrary).readOutlines(book).at(-1)!.children![0];
    expect(tab.children).toEqual([{ title: "Part 1 Ferries", pageIndex: tab.pageIndex + 1,
      children: [{ title: "4 Fares", pageIndex: tab.pageIndex + 2 }] }]);
  });

  it("uses a corrected manual PDF identity in the generated book index", async () => {
    const pdf = await sourcePdf("Grant", [[400, 500]]);
    let state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.grant = attached("grant", "other", "2009scc32", "2009scc32",
      "grant", pdf);
    state.authorityOrder = ["grant"];
    state.bindings.grant = { kind: "local-file", handleId: "grant", lastSeen: {
      name: "2009scc32.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    state = reduceAuthoritiesDraft(state, { type: "edit-authority", authorityId: "grant",
      kind: "case", citation: "2009 SCC 32", name: "R v Grant" });

    const built = await buildAuthorities({ draft: state, title: "Appeal authorities",
      workProduct: { id: "manual-identity", revision: 1 }, sources: { grant: { bytes: pdf } } });
    const book = await PDFDocument.load(built.artifacts.book!.bytes);
    expect(pageContent(book, book.getPage(1)).toUpperCase()).toContain(
      Buffer.from("R v Grant, 2009 SCC 32", "latin1").toString("hex").toUpperCase());
    expect(built.receipt.authorities[0]).toMatchObject({ kind: "case",
      citation: "2009 SCC 32", name: "R v Grant, 2009 SCC 32", tab: "Tab 1" });
  });

  it("does not parse manual PDFs that have no cited passage to mark", async () => {
    const pdf = await sourcePdf("Uncited", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.settings.scannedPdfPolicy = "page-margin";
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    expect([...authoritiesTextRoles(state)]).toEqual([]);
    state.authorities.item.locators = [{ kind: "paragraph", label: "12" }];
    expect([...authoritiesTextRoles(state)]).toEqual(["item"]);
  });

  it("binds exact body quotations only to the authority pinpoint in that footnote", async () => {
    const pdf = await sourcePdf("Quoted", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    const quote = "This exact passage governs the result";
    state.units = [{ id: "body", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [[4, quote.length + 2]], pageNumbers: [2], text: `\u201c${quote}\u201d`,
      occurrenceIds: [] },
    { id: "footnote:4", kind: "footnote", ordinal: 1, footnoteId: 4,
      footnoteRefs: [], pageNumbers: [2], text: "2024 SCC 1 at para 12",
      occurrenceIds: ["cite"] }];
    state.occurrences.cite = { id: "cite", unitId: "footnote:4", start: 0, end: 23,
      text: "2024 SCC 1 at para 12", authoritySpan: { start: 0, end: 10, text: "2024 SCC 1" },
      coreSpan: { start: 0, end: 10, text: "2024 SCC 1" },
      pinpointSpan: { start: 14, end: 23, text: "at para 12" }, kind: "case",
      citation: "2024 SCC 1", authorityId: "item", reference: null,
      pinpoints: [{ kind: "paragraph", text: "12" }], evidenceIds: [],
      sourceTextSha256: sha256("2024 SCC 1 at para 12"), localOrdinal: 0, reviewed: true };
    expect(authorityPassageRequests(state, "item")).toEqual([{
      locators: [{ kind: "paragraph", label: "12" }], exactQuotes: [quote],
    }]);
    expect(authorityPassageTargets(state, "item")).toEqual([{
      id: "passage:1", locatorKind: "paragraph", locator: "12", exactQuotes: [quote],
    }]);
    expect([...authoritiesTextRoles(state)]).toEqual(["item"]);
    state.occurrences.cite.pinpoints = [{ kind: "page", text: "1" }];
    state.settings.passageMarking = "text";
    expect([...authoritiesTextRoles(state)]).toEqual(["item"]);
  });

  it("marks a cited PDF page without extracting its text", async () => {
    const pdf = await sourcePdf("Page pinpoint", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.settings.scannedPdfPolicy = "page-margin";
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorities.item.locators = [{ kind: "page", label: "1" }];
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    expect([...authoritiesTextRoles(state)]).toEqual([]);
    const result = await buildAuthorities({ draft: state, title: "Page pinpoint",
      workProduct: { id: "page-pinpoint", revision: 1 }, sources: { item: { bytes: pdf, pageBindings: resolvePdfPagination(["1"], []) } } });
    const source = await PDFDocument.load(pdf), book = await PDFDocument.load(result.artifacts.book!.bytes);
    expect(pageHasRgb(pageContent(book, book.getPage(2)), [.75, .08, .08])).toBe(false);
    expect(annotSubtypes(book, 2)).toEqual(["/Square"]);
    expect(annotContents(book, 2)).toEqual(["Cited page"]);
  });

  it("renders each passage-marking style from exact PDF geometry", async () => {
    const pdf = await sourcePdf("[1] exact words", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorities.item.locators = [{ kind: "paragraph", label: "1" }];
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    const passageGeometry = {
      schemaVersion: "legalpdf.passage-geometry.v1" as const,
      sourceSha256: sha256(pdf), parserVersion: "test",
      coordinateSpace: "visible_crop_box" as const, coordinateOrigin: "top_left" as const,
      rotationApplied: true as const, targets: [{ id: "passage:1", status: "found" as const,
        locatorKind: "paragraph" as const, locator: "1", printed: true,
        pages: [{ pageNumber: 1, width: 400, height: 500, source: "native" as const,
          text: "[1] exact words", passageRects: [[40, 40, 300, 110] as [number, number, number, number]] }],
        quotes: [{ text: "exact words", status: "found" as const, pageNumber: 1,
          rects: [[70, 65, 170, 78] as [number, number, number, number]] }] }],
    };
    const marks = async (style: AuthoritiesDraft["settings"]["passageMarking"]) => {
      const marked = structuredClone(state); marked.settings.passageMarking = style;
      const built = await buildAuthorities({ draft: marked, title: style,
        workProduct: { id: style, revision: 1 },
        sources: { item: { bytes: pdf, passageGeometry } } });
      const book = await PDFDocument.load(built.artifacts.book!.bytes);
      return annotSubtypes(book, 2).sort();
    };
    expect(await marks("none")).toEqual([]);
    expect(await marks("sidelined")).toEqual(["/Square"]);
    expect(await marks("paragraph")).toEqual(["/Highlight"]);
    expect(await marks("text")).toEqual(["/Highlight"]);
    expect(await marks("margin")).toEqual(["/Highlight", "/Square"]);
    const marked = structuredClone(state); marked.settings.passageMarking = "margin";
    const markedBook = await PDFDocument.load((await buildAuthorities({ draft: marked,
      title: "Marked", workProduct: { id: "marked", revision: 1 },
      sources: { item: { bytes: pdf, passageGeometry } } })).artifacts.book!.bytes);
    expect(annotSubtypes(markedBook, 2).sort()).toEqual(["/Highlight", "/Square"]);
    const highlight = pageAnnots(markedBook, 2).find((annot) =>
      String(annot.lookup(PDFName.of("Subtype"))) === "/Highlight")!;
    expect(highlight.lookup(PDFName.of("QuadPoints"), PDFArray).size()).toBe(8);
    expect(highlight.lookup(PDFName.of("Contents"), PDFHexString).decodeText())
      .toContain("exact words");
    const outline = markedBook.catalog.lookup(PDFName.of("Outlines"), PDFDict)
      .lookup(PDFName.of("First"), PDFDict).lookup(PDFName.of("Next"), PDFDict)
      .lookup(PDFName.of("Next"), PDFDict).lookup(PDFName.of("First"), PDFDict)
      .lookup(PDFName.of("First"), PDFDict);
    expect(outline.lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe("para 1");
    expect(String(outline.lookup(PDFName.of("Dest"), PDFArray).get(0)))
      .toBe(String(markedBook.getPage(2).ref));
  });

  it("omits highlights the user excluded in the review step", async () => {
    const pdf = await sourcePdf("Passage", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorities.item.locators = [{ kind: "paragraph", label: "1" }];
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    state.settings.passageMarking = "paragraph";
    const passageGeometry = {
      schemaVersion: "legalpdf.passage-geometry.v1" as const,
      sourceSha256: sha256(pdf), parserVersion: "test",
      coordinateSpace: "visible_crop_box" as const, coordinateOrigin: "top_left" as const,
      rotationApplied: true as const, targets: [{ id: "passage:1", status: "found" as const,
        locatorKind: "paragraph" as const, locator: "1",
        pages: [{ pageNumber: 1, width: 400, height: 500, source: "native" as const,
          passageRects: [[40, 40, 300, 110] as [number, number, number, number]] }],
        quotes: [] }],
    };
    const excluded = reduceAuthoritiesDraft(state, { type: "set-highlight-exclusion",
      authorityId: "item", locator: { kind: "paragraph", label: "1" }, excluded: true });
    expect(excluded.authorities.item.highlightExclusions).toEqual([{ kind: "paragraph", label: "1" }]);
    const built = await buildAuthorities({ draft: excluded, title: "Excluded",
      workProduct: { id: "excluded", revision: 1 },
      sources: { item: { bytes: pdf, passageGeometry } } });
    expect(annotSubtypes(await PDFDocument.load(built.artifacts.book!.bytes), 2)).toEqual([]);
    const restored = reduceAuthoritiesDraft(excluded, { type: "set-highlight-exclusion",
      authorityId: "item", locator: { kind: "paragraph", label: "1" }, excluded: false });
    expect(restored.authorities.item.highlightExclusions).toBeUndefined();
  });

  it("keeps the cited-page margin for page locators whose geometry has no rects", async () => {
    const pdf = await sourcePdf("Passage", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorities.item.locators = [{ kind: "page", label: "1" }];
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    const passageGeometry = {
      schemaVersion: "legalpdf.passage-geometry.v1" as const,
      sourceSha256: sha256(pdf), parserVersion: "test",
      coordinateSpace: "visible_crop_box" as const, coordinateOrigin: "top_left" as const,
      rotationApplied: true as const, targets: [{ id: "passage:1", status: "found" as const,
        locatorKind: "page" as const, locator: "1",
        pages: [{ pageNumber: 1, width: 400, height: 500, source: "native" as const,
          passageRects: [] }], quotes: [] }],
    };
    const built = await buildAuthorities({ draft: state, title: "Page geometry",
      workProduct: { id: "page-geometry", revision: 1 },
      sources: { item: { bytes: pdf, passageGeometry } } });
    const book = await PDFDocument.load(built.artifacts.book!.bytes);
    expect(annotSubtypes(book, 2)).toEqual(["/Square"]);
  });

  it("draws no marks at all once every passage is excluded", async () => {
    const pdf = await sourcePdf("Passage", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test", "item", pdf);
    state.authorities.item.locators = [{ kind: "paragraph", label: "1" }];
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    const passageGeometry = {
      schemaVersion: "legalpdf.passage-geometry.v1" as const,
      sourceSha256: sha256(pdf), parserVersion: "test",
      coordinateSpace: "visible_crop_box" as const, coordinateOrigin: "top_left" as const,
      rotationApplied: true as const, targets: [{ id: "passage:1", status: "found" as const,
        locatorKind: "paragraph" as const, locator: "1",
        pages: [{ pageNumber: 1, width: 400, height: 500, source: "native" as const,
          passageRects: [[40, 40, 300, 110] as [number, number, number, number]] }],
        quotes: [] }],
    };
    const excluded = reduceAuthoritiesDraft(state, { type: "set-highlight-exclusion",
      authorityId: "item", locator: { kind: "paragraph", label: "1" }, excluded: true });
    const built = await buildAuthorities({ draft: excluded, title: "Excluded margin",
      workProduct: { id: "excluded-margin", revision: 1 },
      sources: { item: { bytes: pdf, passageGeometry } } });
    expect(annotSubtypes(await PDFDocument.load(built.artifacts.book!.bytes), 2)).toEqual([]);
  });

  it("marks the page that prints a cited paragraph when geometry is ambiguous", async () => {
    const pdf = await sourcePdf("Bilingual decision", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.item = attached("item", "case", "2009 SCC 32", "R v Grant", "item", pdf);
    state.authorities.item.locators = [{ kind: "paragraph", label: "29" }];
    state.authorityOrder = ["item"];
    state.bindings.item = { kind: "local-file", handleId: "item", lastSeen: {
      name: "item.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf),
    } };
    const passageGeometry = { schemaVersion: "legalpdf.passage-geometry.v1" as const,
      sourceSha256: sha256(pdf), parserVersion: "test",
      coordinateSpace: "visible_crop_box" as const, coordinateOrigin: "top_left" as const,
      rotationApplied: true as const, targets: [{ id: "passage:1", status: "ambiguous" as const,
        locatorKind: "paragraph" as const, locator: "29", pages: [], quotes: [] }] };
    const built = await buildAuthorities({ draft: state, title: "Bilingual authority",
      workProduct: { id: "ambiguous-paragraph", revision: 1 }, sources: { item: {
        bytes: pdf, pageTextByPage: ["Reporter header [29] The cited paragraph."],
        passageGeometry } } });
    const book = await PDFDocument.load(built.artifacts.book!.bytes);
    expect(annotSubtypes(book, 2)).toEqual(["/Square"]);
    expect(annotContents(book, 2)).toEqual(["Cited page"]);
  });

  it("stops before emitting artifacts when the build is cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "table");
    await expect(buildAuthorities({ draft: state, title: "Cancelled",
      workProduct: { id: "cancelled", revision: 1 }, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps first-reference order and assigns procedural book tabs", async () => {
    const zPdf = await sourcePdf("Zulu", [[400, 500]]);
    const aPdf = await sourcePdf("Alpha", [[400, 500]]);
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "both");
    const zulu = attached("zulu", "case", "2024 ABKB 2", "Zulu v Test", "z", zPdf);
    const alpha = attached("alpha", "case", "2024 ABKB 1", "Alpha v Test", "a", aPdf);
    const omitted = { ...attached("omitted", "case", "2024 ABKB 3", "Omitted v Test", "o", aPdf),
      excluded: true };
    Object.assign(state, {
      settings: { ...state.settings, tableOrder: "first-reference" },
      bindings: {
        z: { kind: "local-file", handleId: "z", lastSeen: { name: "zulu.pdf",
          size: zPdf.length, modified: 1, sha256: sha256(zPdf) } },
        a: { kind: "local-file", handleId: "a", lastSeen: { name: "alpha.pdf",
          size: aPdf.length, modified: 1, sha256: sha256(aPdf) } },
        o: { kind: "local-file", handleId: "o", lastSeen: { name: "omitted.pdf",
          size: aPdf.length, modified: 1, sha256: sha256(aPdf) } },
      },
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [1], text: "Zulu Alpha",
        occurrenceIds: ["zulu-cite", "alpha-cite"] }],
      occurrences: {
        "zulu-cite": { id: "zulu-cite", unitId: "body:0", start: 0, end: 4,
          text: "Zulu", authoritySpan: { start: 0, end: 4, text: "Zulu" },
          coreSpan: { start: 0, end: 4, text: "Zulu" }, pinpointSpan: null,
          kind: "case", citation: zulu.citation, authorityId: zulu.id, reference: null,
          pinpoints: [], evidenceIds: [], sourceTextSha256: "unit", localOrdinal: 0,
          reviewed: true },
        "alpha-cite": { id: "alpha-cite", unitId: "body:0", start: 5, end: 10,
          text: "Alpha", authoritySpan: { start: 5, end: 10, text: "Alpha" },
          coreSpan: { start: 5, end: 10, text: "Alpha" }, pinpointSpan: null,
          kind: "case", citation: alpha.citation, authorityId: alpha.id, reference: null,
          pinpoints: [], evidenceIds: [], sourceTextSha256: "unit", localOrdinal: 1,
          reviewed: true },
      }, authorities: { zulu, omitted, alpha }, authorityOrder: ["zulu", "omitted", "alpha"],
    });
    const input = { draft: state, title: "Order", workProduct: { id: "order", revision: 1 },
      sources: { z: { bytes: zPdf }, a: { bytes: aPdf }, o: { bytes: aPdf } } };
    const automatic = await buildAuthorities(input);
    expect(automatic.receipt.authorities.map(({ id }) => id)).toEqual(["zulu", "omitted", "alpha"]);
    const xml = await (await JSZip.loadAsync(automatic.artifacts.table!.bytes))
      .file("word/document.xml")!.async("string");
    expect(xml.indexOf("Zulu v Test")).toBeLessThan(xml.indexOf("Alpha v Test"));

    const manual = structuredClone(state);
    manual.outputMode = "book";
    manual.settings.sourceMode = "manual-originals";
    manual.authorities.zulu.displayName = "Custom Zulu title";
    const preserved = await buildAuthorities({ ...input, draft: manual });
    expect(preserved.receipt.authorities.map(({ id, name, tab }) => [id, name, tab]))
      .toEqual([["zulu", "Custom Zulu title, 2024 ABKB 2", "Tab 1"],
        ["omitted", "Omitted v Test, 2024 ABKB 3", "Not reproduced"],
        ["alpha", "Alpha v Test, 2024 ABKB 1", "Tab 2"]]);
  });

  it("builds an inspectable grouped DOCX and indexed, linked, bookmarked PDF book", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600], [500, 600]]);
    const input = { draft: draft(casePdf, legislationPdf, true),
      title: "Appeal Brief", workProduct: { id: "authorities-1", revision: 4 },
      sources: { "source:grant": { bytes: casePdf,
        pageTextByPage: ["[12] Recognized scanned decision"],
        ocrTextByPage: ["Recognized scanned decision"] },
        "source:fca": { bytes: legislationPdf }, source: { resolved: {
          kind: "document", documentId: "brief-document", versionId: "brief-v2",
          filename: "Brief.docx", sha256: "9".repeat(64),
        } } } } satisfies Parameters<typeof buildAuthorities>[0];
    input.draft.settings.scannedPdfPolicy = "full";
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
        expect.objectContaining({ id: "fca", bindings: [{ kind: "document",
          documentId: "law-document",
          version: { versionId: "law-v3", sha256: sha256(legislationPdf) } }] }),
      ]) });
    expect(result.receipt.authorities.map(({ id }) => id)).toEqual(["article", "fca", "grant"]);
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
    expect(book.getPage(4).getSize()).toEqual({ width: 400, height: 500 });
    expect(pageContent(book, book.getPage(4)).toUpperCase()).toContain(
      Buffer.from("Recognized scanned decision", "latin1").toString("hex").toUpperCase(),
    );
    expect(book.getPage(3).getSize()).toEqual({ width: 500, height: 600 });
    expect(book.getPage(2).getSize()).toEqual({ width: 500, height: 600 });
    expect(book.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(2);
    const outlines = book.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    expect(outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBeGreaterThan(4);
    expect(book.catalog.get(PDFName.of("PageMode"))).toEqual(PDFName.of("UseOutlines"));
    expect(book.catalog.has(PDFName.of("PageLabels"))).toBe(true);

    const citedOnly = structuredClone(input);
    citedOnly.draft.settings.scannedPdfPolicy = "cited-pages";
    citedOnly.draft.authorities.grant.locators = [{ kind: "page", label: "1" }];
    citedOnly.sources["source:grant"].pageTextByPage = ["[12] Recognized cited passage"];
    citedOnly.sources["source:grant"].ocrTextByPage = ["[12] Recognized cited passage"];
    const citedBook = await PDFDocument.load((await buildAuthorities(citedOnly)).artifacts.book!.bytes);
    expect(pageContent(citedBook, citedBook.getPage(4)).toUpperCase()).toContain(
      Buffer.from("[12] Recognized cited passage", "latin1").toString("hex").toUpperCase(),
    );
    const originalScan = structuredClone(citedOnly);
    originalScan.draft.settings.scannedPdfPolicy = "page-margin";
    originalScan.sources["source:grant"].ocrTextByPage = [];
    const originalBook = await PDFDocument.load(
      (await buildAuthorities(originalScan)).artifacts.book!.bytes,
    );
    expect(pageContent(originalBook, originalBook.getPage(4)).toUpperCase()).not.toContain(
      Buffer.from("[12] Recognized cited passage", "latin1").toString("hex").toUpperCase(),
    );
    const noMarks = structuredClone(originalScan);
    noMarks.draft.settings.passageMarking = "none";
    const unmarkedBook = await PDFDocument.load(
      (await buildAuthorities(noMarks)).artifacts.book!.bytes,
    );
    const unmarked = pageContent(unmarkedBook, unmarkedBook.getPage(4));
    const originalSource = await PDFDocument.load(casePdf);
    expect(unmarked).toBe(pageContent(originalSource, originalSource.getPage(0)));
    expect(unmarked).not.toBe(pageContent(originalBook, originalBook.getPage(4)));

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
    expect((await buildAuthorities({ draft: tableDraft, title: "CON",
      workProduct: { id: "authorities-2", revision: 1 } })).artifacts.table?.filename)
      .toBe("_CON.table-of-authorities.docx");

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

  it("uses bound front matter and book-only supplemental PDFs without breaking navigation",
    async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600], [500, 600]]);
    const cover = await sourcePdf("Cover", [[300, 400], [301, 401]]);
    const index = await sourcePdf("Index", [[310, 410], [311, 411]]);
    const supplement = await sourcePdf("Procedural appendix", [[320, 420]]);
    const binding = (name: string, bytes: Uint8Array) => ({ kind: "local-file" as const,
      handleId: `${name}-handle`, lastSeen: { name: `${name}.pdf`, size: bytes.length,
        modified: 1, sha256: sha256(bytes) } });
    const part = (name: string, bytes: Uint8Array) => ({ bindingRole: `book:${name}`,
      filename: `${name}.pdf`, sourceSha256: sha256(bytes) });
    let state = draft(casePdf, legislationPdf); state.outputMode = "book";
    state = reduceAuthoritiesDraft(state, { type: "set-book-part", slot: "cover",
      pdf: part("cover", cover), binding: binding("cover", cover) });
    state = reduceAuthoritiesDraft(state, { type: "set-book-part", slot: "index",
      pdf: part("index", index), binding: binding("index", index) });
    state = reduceAuthoritiesDraft(state, { type: "set-book-supplement",
      supplement: { id: "appendix", bindingRole: "book:appendix",
        filename: "Procedural appendix.pdf", sourceSha256: sha256(supplement) },
      binding: binding("appendix", supplement) });
    const sources = { "source:grant": { bytes: casePdf },
      "source:fca": { bytes: legislationPdf }, "book:cover": { bytes: cover },
      "book:index": { bytes: index }, "book:appendix": { bytes: supplement } };
    const result = await buildAuthorities({ draft: state, title: "Custom book",
      workProduct: { id: "custom-book", revision: 1 }, sources });
    const book = await PDFDocument.load(result.artifacts.book!.bytes);
    expect(book.getTitle()).toBe("Custom book");
    expect(book.getPageCount()).toBe(8);
    expect(book.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(book.getPage(2).getSize()).toEqual({ width: 310, height: 410 });
    expect(book.getPage(4).getSize()).toEqual({ width: 500, height: 600 });
    expect(book.getPage(6).getSize()).toEqual({ width: 400, height: 500 });
    expect(book.getPage(7).getSize()).toEqual({ width: 320, height: 420 });
    expect(result.artifacts.book!.receipt.inputs.map(({ role }) => role))
      .toEqual(expect.arrayContaining(["book:cover", "book:index", "book:appendix"]));

    const labels = book.catalog.lookup(PDFName.of("PageLabels"), PDFDict)
      .lookup(PDFName.of("Nums"), PDFArray);
    expect(labels.lookup(0, PDFNumber).asNumber()).toBe(0);
    expect(labels.lookup(1, PDFDict).lookup(PDFName.of("St"), PDFNumber).asNumber()).toBe(1);
    const outlines = book.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const root = outlines.lookup(PDFName.of("First"), PDFDict);
    const toc = root.lookup(PDFName.of("Next"), PDFDict);
    expect(String(toc.lookup(PDFName.of("Dest"), PDFArray).get(0)))
      .toBe(String(book.getPage(2).ref));
    const authorities = toc.lookup(PDFName.of("Next"), PDFDict);
    expect(authorities.lookup(PDFName.of("Title"), PDFHexString).decodeText())
      .toBe("Authorities");
    const firstAuthority = authorities.lookup(PDFName.of("First"), PDFDict);
    expect(firstAuthority.lookup(PDFName.of("Title"), PDFHexString).decodeText())
      .toContain("Federal Courts Act");
    expect(firstAuthority.lookup(PDFName.of("Next"), PDFDict)
      .lookup(PDFName.of("Title"), PDFHexString).decodeText()).toContain("R v Grant");
    const documents = authorities.lookup(PDFName.of("Next"), PDFDict);
    expect(documents.lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe("Documents");
    const supplementalOutline = documents.lookup(PDFName.of("First"), PDFDict)
      .lookup(PDFName.of("Title"), PDFHexString).decodeText();
    expect(supplementalOutline).toContain("Tab 3");
    expect(supplementalOutline).toContain("Procedural appendix");

    const omittedState = structuredClone(state);
    omittedState.settings.missingSourcePolicy = "omit";
    omittedState.authorities.fca.source = { kind: "unresolved" };
    delete omittedState.bindings["source:fca"];
    const omitted = await buildAuthorities({ draft: omittedState, title: "Book with omission",
      workProduct: { id: "omitted-book", revision: 1 }, sources: {
        "source:grant": { bytes: casePdf }, "book:cover": { bytes: cover },
        "book:index": { bytes: index }, "book:appendix": { bytes: supplement } } });
    const omittedBook = await PDFDocument.load(omitted.artifacts.book!.bytes);
    const omittedDocuments = omittedBook.catalog.lookup(PDFName.of("Outlines"), PDFDict)
      .lookup(PDFName.of("First"), PDFDict).lookup(PDFName.of("Next"), PDFDict)
      .lookup(PDFName.of("Next"), PDFDict).lookup(PDFName.of("Next"), PDFDict);
    expect(omittedDocuments.lookup(PDFName.of("First"), PDFDict)
      .lookup(PDFName.of("Title"), PDFHexString).decodeText()).toContain("Tab 3");

    const tableState = structuredClone(state); tableState.outputMode = "table";
    const table = await buildAuthorities({ draft: tableState, title: "Table only",
      workProduct: { id: "custom-table", revision: 1 }, sources: {
        "source:grant": { bytes: casePdf }, "source:fca": { bytes: legislationPdf } } });
    expect(table.artifacts).not.toHaveProperty("book");
    expect(table.receipt.inputs.map(({ role }) => role)).not.toContain("book:appendix");
    const tableXml = await (await JSZip.loadAsync(table.artifacts.table!.bytes))
      .file("word/document.xml")!.async("string");
    expect(tableXml).not.toMatch(/>Tab(?: [A-Z0-9]+)?</u);

    state = reduceAuthoritiesDraft(state, { type: "clear-book-part", slot: "index" });
    const generated = await PDFDocument.load((await buildAuthorities({ draft: state,
      title: "Generated index", workProduct: { id: "custom-book", revision: 2 }, sources }))
      .artifacts.book!.bytes);
    const annots = generated.getPage(2).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(3);
    expect(annots.asArray().map((ref) => String(generated.context.lookup(ref, PDFDict)
      .lookup(PDFName.of("Dest"), PDFArray).get(0))))
      .toEqual([3, 5, 6].map((page) => String(generated.getPage(page).ref)));
  });

  it("keeps missing authorities in the table and either placeholders or omits them from the book", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600]]);
    const articlePdf = await sourcePdf("Article", [[450, 550]]);
    const state = draft(casePdf, legislationPdf);
    delete state.bindings["source:fca"];
    state.authorities.fca.source = { kind: "unresolved" };
    state.authorities.article.excluded = false;
    state.authorities.article.source = { kind: "attached", sources: [{
      bindingRole: "source:article", filename: "article.pdf",
      sourceSha256: sha256(articlePdf), sourceUrl: null,
      origin: "manual", language: "en" }] };
    state.bindings["source:article"] = { kind: "local-file", handleId: "article",
      lastSeen: { name: "article.pdf", size: articlePdf.length, modified: 1,
        sha256: sha256(articlePdf) } };
    const sources = { "source:grant": { bytes: casePdf },
      "source:article": { bytes: articlePdf } };
    const placeholder = await buildAuthorities({ draft: state, title: "Missing source",
      workProduct: { id: "missing-source", revision: 1 }, sources });
    const placeholderBook = await PDFDocument.load(placeholder.artifacts.book!.bytes);
    expect(placeholderBook.getPageCount()).toBe(5);
    expect(pageAnnots(placeholderBook, 1).flatMap(annot => {
      const destination = annot.lookupMaybe(PDFName.of("Dest"), PDFArray);
      return destination ? [String(destination.get(0))] : [];
    })).toEqual(placeholderBook.getPages().slice(2).map(page => page.ref.toString()));
    expect(pageContent(placeholderBook, placeholderBook.getPage(3)).toUpperCase()).toContain(
      Buffer.from("Source PDF unavailable", "latin1").toString("hex").toUpperCase(),
    );
    expect(placeholder.receipt.authorities.find(({ id }) => id === "article")?.tab).toBe("Tab 1");
    const placeholderTable = await (await JSZip.loadAsync(placeholder.artifacts.table!.bytes))
      .file("word/document.xml")!.async("string");
    expect(placeholderTable).toContain("Federal Courts Act");

    const omitted = structuredClone(state); omitted.settings.missingSourcePolicy = "omit";
    const omitResult = await buildAuthorities({ draft: omitted, title: "Omitted source",
      workProduct: { id: "missing-source", revision: 2 }, sources });
    const omitBook = await PDFDocument.load(omitResult.artifacts.book!.bytes);
    expect(omitBook.getPageCount()).toBe(4);
    expect(pageAnnots(omitBook, 1).flatMap(annot => {
      const destination = annot.lookupMaybe(PDFName.of("Dest"), PDFArray);
      return destination ? [String(destination.get(0))] : [];
    })).toEqual(omitBook.getPages().slice(2).map(page => page.ref.toString()));
    expect(omitBook.getPage(3).getSize()).toEqual({ width: 400, height: 500 });
    expect(omitResult.receipt.authorities.find(({ id }) => id === "fca")?.tab)
      .toBe("Tab 2");
    expect(omitResult.receipt.authorities.find(({ id }) => id === "article")?.tab).toBe("Tab 1");
    expect(omitResult.receipt.authorities.find(({ id }) => id === "grant")?.tab).toBe("Tab 3");
  });

  it("exports an explicit incomplete draft with a real stub, fixed labels, and source guards", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const lawPdf = await sourcePdf("Act", [[500, 600]]);
    let state = reduceAuthoritiesDraft(draft(casePdf, lawPdf),
      { type: "set-profile", profileId: "ab-court-of-kings-bench" });
    state.outputMode = "book";
    state.authorities.fca.source = { kind: "unresolved" }; delete state.bindings["source:fca"];
    state = reduceAuthoritiesDraft(state, { type: "set-settings", settings: {
      allowIncomplete: true, missingSourcePolicy: "omit", tabLabels: ["Schedule A", "Schedule B"],
    } });
    const input = { draft: state, title: "Working draft", workProduct: { id: "draft", revision: 1 },
      sources: { "source:grant": { bytes: casePdf } } };
    const result = await buildAuthorities(input), book = await PDFDocument.load(result.artifacts.book!.bytes);
    expect(result.artifacts.book!.filename).toContain("draft-incomplete");
    expect(book.getTitle()).toContain("DRAFT");
    expect(book.getPageCount()).toBe(4);
    expect(result.receipt.authorities.filter(({ excluded }) => !excluded).map(({ tab }) => tab))
      .toEqual(["Schedule A", "Schedule B"]);
    expect(pageContent(book, book.getPage(2)).toUpperCase()).toContain(pdfTextHex("Source PDF unavailable"));
    expect(pageContent(book, book.getPage(0)).toUpperCase()).toContain(pdfTextHex("NOT FOR FILING"));
    await expect(buildAuthorities({ ...input, sources: { "source:grant": { bytes: lawPdf } } }))
      .rejects.toThrow(/changed|exact current input/iu);
  });

  it("enforces current Alberta source delivery instead of emitting court placeholders", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600]]);
    const sources = { "source:grant": { bytes: casePdf },
      "source:fca": { bytes: legislationPdf } };
    const kingsBench = reduceAuthoritiesDraft(draft(casePdf, legislationPdf),
      { type: "set-profile", profileId: "ab-court-of-kings-bench" });
    kingsBench.authorities.fca.source = { kind: "unresolved" };
    delete kingsBench.bindings["source:fca"];
    await expect(buildAuthorities({ draft: kingsBench, title: "King's Bench book",
      workProduct: { id: "abkb-book", revision: 1 }, sources }))
      .rejects.toThrow(/Attach a complete PDF.*Federal Courts Act/u);

    const appealInput = draft(casePdf, legislationPdf), appealSha = "9".repeat(64);
    appealInput.import = { kind: "document", bindingRole: "source", filename: "Factum.docx",
      fileType: "docx", snapshot: { documentId: "factum", versionId: "v1",
        sha256: appealSha } };
    appealInput.bindings.source = { kind: "document", documentId: "factum",
      version: { versionId: "v1", sha256: appealSha } };
    const appeal = reduceAuthoritiesDraft(reduceAuthoritiesDraft(appealInput,
      { type: "set-profile", profileId: "ab-court-of-appeal" }),
    { type: "set-document-output", enabled: false });
    await expect(buildAuthorities({ draft: appeal, title: "Appeal factum",
      workProduct: { id: "abca-table", revision: 1 } }))
      .rejects.toThrow(/publicly accessible source link.*R v Grant/u);
    if (appeal.authorities.grant.source.kind !== "attached" ||
        appeal.authorities.fca.source.kind !== "attached") throw new Error("invalid fixture");
    appeal.authorities.grant.source.sources[0].sourceUrl = "https://decisions.scc-csc.ca/example";
    appeal.authorities.fca.source.sources[0].sourceUrl = "https://laws-lois.justice.gc.ca/example";
    const result = await buildAuthorities({ draft: appeal, title: "Appeal factum",
      workProduct: { id: "abca-table", revision: 2 } });
    expect(Object.keys(result.artifacts)).toEqual(["table"]);
    const zip = await JSZip.loadAsync(result.artifacts.table!.bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
    expect(xml.indexOf("R v Grant")).toBeLessThan(xml.indexOf("Federal Courts Act"));
    expect(rels).toContain(appeal.authorities.grant.source.sources[0].sourceUrl);
    expect(rels).toContain(appeal.authorities.fca.source.sources[0].sourceUrl);
    expect(rels).toContain("https://example.test/article");

    const filingPdf = await sourcePdf("Appeal factum", [[612, 792], [612, 792]]);
    const filingSha = sha256(filingPdf), withFiling = draft(casePdf, legislationPdf);
    withFiling.import = { kind: "document", bindingRole: "source", filename: "Factum.pdf",
      fileType: "pdf", snapshot: { documentId: "factum", versionId: "v1",
        sha256: filingSha } };
    withFiling.bindings.source = { kind: "document", documentId: "factum",
      version: { versionId: "v1", sha256: filingSha } };
    const filingDraft = reduceAuthoritiesDraft(reduceAuthoritiesDraft(withFiling,
      { type: "set-profile", profileId: "ab-court-of-appeal" }),
      { type: "set-document-output", enabled: true });
    if (filingDraft.authorities.grant.source.kind !== "attached")
      throw new Error("invalid fixture");
    filingDraft.authorities.grant.source.sources[0].sourceUrl = "https://decisions.scc-csc.ca/grant";
    const filingResult = await buildAuthorities({ draft: filingDraft, title: "Appeal factum",
      workProduct: { id: "abca-filing", revision: 1 }, sources: {
        source: { bytes: filingPdf }, "source:grant": { bytes: casePdf },
        "source:fca": { bytes: legislationPdf },
      } });
    expect(Object.keys(filingResult.artifacts).sort()).toEqual(["annotated-document", "table"]);
    expect(filingResult.artifacts["annotated-document"]).toMatchObject({
      filename: "Appeal factum.with-table-of-authorities.pdf", mimeType: "application/pdf",
      pageCount: 4, receipt: { steps: ["Appended the linked Table of Authorities",
        "Appended unlinked authority PDFs with bookmarks"] },
    });
    const filing = await PDFDocument.load(filingResult.artifacts["annotated-document"]!.bytes);
    const tablePage = filing.getPage(2);
    const annotations = tablePage.node.lookup(PDFName.of("Annots"), PDFArray).asArray()
      .map((ref) => filing.context.lookup(ref, PDFDict));
    expect(annotations.some((annotation) => annotation.has(PDFName.of("A")))).toBe(true);
    expect(annotations.some((annotation) => annotation.has(PDFName.of("Dest")))).toBe(true);
    const outlines = filing.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const first = outlines.lookup(PDFName.of("First"), PDFDict);
    expect(first.lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe("Filing document");
    expect(filing.catalog.lookup(PDFName.of("PageMode"), PDFName).asString())
      .toBe("/UseOutlines");

    filingDraft.authorities.fca.source.sources[0].sourceUrl = "https://laws-lois.justice.gc.ca/example";
    const linkedFiling = await buildAuthorities({ draft: filingDraft, title: "Appeal factum",
      workProduct: { id: "abca-filing", revision: 2 }, sources: {
        source: { bytes: filingPdf }, "source:grant": { bytes: casePdf },
        "source:fca": { bytes: legislationPdf },
      } });
    expect(linkedFiling.artifacts["annotated-document"]?.receipt.steps)
      .toEqual(["Appended the linked Table of Authorities"]);

    filingDraft.authorities.fca.source = { kind: "unresolved" };
    delete filingDraft.bindings["source:fca"];
    await expect(buildAuthorities({ draft: filingDraft, title: "Appeal factum",
      workProduct: { id: "abca-filing", revision: 2 }, sources: { source: { bytes: filingPdf } } }))
      .rejects.toThrow(/publicly accessible source link or PDF.*Federal Courts Act/u);
  });

  it("makes Federal books continuously numbered, externally linked, and complete", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600]]);
    let state = reduceAuthoritiesDraft(draft(casePdf, legislationPdf),
      { type: "set-profile", profileId: "federal-court-appeal" });
    if (state.authorities.grant.source.kind !== "attached") throw new Error("missing fixture source");
    state.authorities.grant.source.sources[0].sourceUrl = "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/7799/index.do";
    const sources = { "source:grant": { bytes: casePdf },
      "source:fca": { bytes: legislationPdf } };
    const result = await buildAuthorities({ draft: state, title: "Federal book",
      workProduct: { id: "federal-book", revision: 1 }, sources });
    const book = await PDFDocument.load(result.artifacts.book!.bytes);
    const title = "Book of Statutes, Regulations and Authorities";
    expect(result.artifacts.book!.filename).toBe(
      "Federal book.book-of-statutes-regulations-and-authorities.pdf");
    expect(book.getTitle()).toBe(title);
    expect(result.artifacts.book!.receipt.settings.sourceReceiptIds)
      .toEqual(expect.arrayContaining(["fc-rules", "fc-practice-guidelines-2025",
        "fc-efiling", "fc-efiling-guide-2020"]));
    const cover = pageContent(book, book.getPage(0)).toUpperCase();
    for (const value of ["Court File No. T-123-26", "FEDERAL COURT", "BETWEEN:",
      "North Prairie Ltd.", "Applicant", "Attorney General of Canada", "Respondent",
      "APPLICATION UNDER Federal Courts Act, section 18.1", title.toUpperCase()]) {
      expect(cover).toContain(pdfTextHex(value));
    }
    book.getPages().forEach((page) => {
      const content = pageContent(book, page);
      expect(content).toContain("Tj");
      const crop = page.getCropBox();
      expect(generatedTextLayout(content).positions.some(([x, y]) =>
        Math.abs(y - (crop.y + 54)) < .01 && x > crop.x + crop.width / 2)).toBe(true);
    });
    for (const page of book.getPages().slice(0, 2)) {
      const layout = generatedTextLayout(pageContent(book, page));
      expect(new Set(layout.sizes)).toEqual(new Set([12]));
      expect(layout.fonts.every((font) => font.startsWith("Times-"))).toBe(true);
      expect(layout.positions.every(([x, y]) => x >= 99 && x <= 513 && y >= 54 && y <= 721))
        .toBe(true);
    }
    expect(pageHasRgb(pageContent(book, book.getPage(0)), [128 / 255, 0, 32 / 255])).toBe(false);
    const annotations = book.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray);
    const external = annotations.asArray().map((ref) => book.context.lookup(ref, PDFDict))
      .find((annotation) => annotation.has(PDFName.of("A")));
    // Decisia links carry the iframe/mobile parameters the document text
    // needs to render at all, the same as every other legal-source link.
    expect(external?.lookup(PDFName.of("A"), PDFDict)
      .lookup(PDFName.of("URI"), PDFHexString).decodeText())
      .toBe(`${state.authorities.grant.source.sources[0].sourceUrl
        }?iframe=true&site_preference=mobile`);
    expect(book.catalog.lookup(PDFName.of("Outlines"), PDFDict)
      .lookup(PDFName.of("First"), PDFDict)
      .lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe(title);

    state.authorities.fca.source = { kind: "unresolved" };
    delete state.bindings["source:fca"];
    await expect(buildAuthorities({ draft: state, title: "Incomplete Federal book",
      workProduct: { id: "federal-book", revision: 2 }, sources }))
      .rejects.toThrow(/Attach a complete PDF.*Federal Courts Act/u);
  });

  it("keeps explicit English and French enactments under one Federal book tab", async () => {
    const decision = await sourcePdf("Decision", [[400, 500]]);
    const english = await sourcePdf("English enactment", [[400, 500]]);
    const french = await sourcePdf("French enactment", [[400, 500]]);
    let state = reduceAuthoritiesDraft(draft(decision, english),
      { type: "set-profile", profileId: "federal-court" });
    state.settings.bookRole = "applicant";
    const enactment = state.authorities.fca;
    if (enactment.source.kind !== "attached") throw new Error("missing fixture source");
    enactment.source.sources = [
      { ...enactment.source.sources[0], language: "en" },
      { bindingRole: "source:fca:fr", filename: "fca-fr.pdf", sourceSha256: sha256(french),
        sourceUrl: null, origin: "manual", language: "fr" },
    ];
    state.bindings["source:fca:fr"] = { kind: "local-file", handleId: "fca-fr",
      lastSeen: { name: "fca-fr.pdf", size: french.length, modified: 1,
        sha256: sha256(french) } };
    const sources = { "source:grant": { bytes: decision }, "source:fca": { bytes: english },
      "source:fca:fr": { bytes: french } };
    const built = await buildAuthorities({ draft: state, title: "Bilingual authorities",
      workProduct: { id: "bilingual", revision: 1 }, sources });
    const book = await PDFDocument.load(built.artifacts.book!.bytes);
    const content = book.getPages().map((page) => pageContent(book, page).toUpperCase());
    const englishPage = content.findIndex((value) => value.includes(
      pdfTextHex("English enactment page 1")));
    const frenchPage = content.findIndex((value) => value.includes(
      pdfTextHex("French enactment page 1")));
    expect(frenchPage).toBe(englishPage + 1);
    expect((content[1].match(new RegExp(pdfTextHex("Federal Courts Act"), "gu")) ?? []))
      .toHaveLength(1);
    expect(built.receipt.authorities.find(({ id }) => id === "fca")?.bindings)
      .toHaveLength(2);

    enactment.source.sources = [enactment.source.sources[0]];
    delete state.bindings["source:fca:fr"];
    await expect(buildAuthorities({ draft: state, title: "Incomplete enactment",
      workProduct: { id: "incomplete-bilingual", revision: 1 }, sources }))
      .rejects.toThrow(/one bilingual PDF or both English and French PDFs.*Federal Courts Act/u);
  });

  it("uses mapped, marked case extracts only for Federal paper books", async () => {
    const decision = await sourcePdf("Decision", Array.from({ length: 9 }, () =>
      [400, 500] as [number, number]));
    const texts = ["Headnote", "[1] Reasons", "[2] omitted", "[3] omitted",
      "[9] preceding", "[10] cited", "[11] following", "[12] omitted", "[13] omitted"];
    const sourceUrl = "https://www.canlii.org/en/ca/scc/doc/2024/2024scc1/2024scc1.html";
    const geometry = { schemaVersion: "legalpdf.passage-geometry.v1" as const,
      sourceSha256: sha256(decision), parserVersion: "test",
      coordinateSpace: "visible_crop_box" as const, coordinateOrigin: "top_left" as const,
      rotationApplied: true as const, targets: [{ id: "passage:1", status: "found" as const,
        locatorKind: "paragraph" as const, locator: "10", printed: true,
        pages: [{ pageNumber: 6, width: 400, height: 500, source: "native" as const,
          text: "[10] cited", passageRects: [[40, 40, 300, 90] as [number, number, number, number]] }], quotes: [] }] };
    const encoded = (value: string) => Buffer.from(value, "latin1").toString("hex").toUpperCase();
    for (const profileId of ["federal-court", "federal-court-appeal",
      "federal-court-of-appeal"] as const) {
      let state = withForm66(createAuthoritiesDraft({ kind: "manual" }, {}, "book"));
      state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test",
        "source:item", decision);
      state.authorities.item.locators = [{ kind: "paragraph", label: "10" }];
      if (state.authorities.item.source.kind !== "attached") throw new Error("fixture");
      state.authorities.item.source.sources[0].sourceUrl = sourceUrl;
      state.authorityOrder = ["item"];
      state.bindings["source:item"] = { kind: "local-file", handleId: "item", lastSeen: {
        name: "item.pdf", size: decision.length, modified: 1, sha256: sha256(decision) } };
      state = reduceAuthoritiesDraft(state, { type: "set-profile", profileId });
      state.settings.bookRole ??= "applicant";
      state = reduceAuthoritiesDraft(state, { type: "set-settings",
        settings: { filingMedium: "paper" } });
      const built = await buildAuthorities({ draft: state, title: "Paper authorities",
        workProduct: { id: profileId, revision: 1 }, sources: { "source:item": {
          bytes: decision, pageTextByPage: texts, passageGeometry: geometry } } });
      const book = await PDFDocument.load(built.artifacts.book!.bytes);
      expect(book.getPageCount()).toBe(profileId === "federal-court" ? 7 : 8);
      [1, 2, 5, 6, 7].forEach((sourcePage, index) => {
        const content = pageContent(book, book.getPage(index + 2)).toUpperCase();
        expect(content).toContain(encoded(`Decision page ${sourcePage}`));
        expect(content).toContain(encoded("FREE PUBLIC DATABASE: www.canlii.org"));
      });
      const databaseLink = book.getPage(2).node.lookup(PDFName.of("Annots"), PDFArray).asArray()
        .map((ref) => book.context.lookup(ref, PDFDict)).find((item) => item.has(PDFName.of("A")))!
        .lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI"), PDFHexString).decodeText();
      expect(databaseLink).toBe(sourceUrl);
      expect(annotSubtypes(book, 5)).toEqual(["/Square", "/Link"]);
      const authorityOutline = book.catalog.lookup(PDFName.of("Outlines"), PDFDict)
        .lookup(PDFName.of("First"), PDFDict).lookup(PDFName.of("Next"), PDFDict)
        .lookup(PDFName.of("Next"), PDFDict).lookup(PDFName.of("First"), PDFDict);
      const passage = authorityOutline.lookup(PDFName.of("First"), PDFDict);
      expect(String(passage.lookup(PDFName.of("Dest"), PDFArray).get(0)))
        .toBe(String(book.getPage(5).ref));
    }
  });

  it("keeps complete reasons outside the Federal paper-extract case", async () => {
    const decision = await sourcePdf("Full decision", Array.from({ length: 4 }, () =>
      [400, 500] as [number, number]));
    for (const filingMedium of ["electronic", "paper"] as const) {
      let state = withForm66(createAuthoritiesDraft({ kind: "manual" }, {}, "book"));
      state.authorities.item = attached("item", "case", "2024 SCC 1", "R v Test",
        "source:item", decision);
      state.authorities.item.locators = [{ kind: "paragraph", label: "10" }];
      if (state.authorities.item.source.kind !== "attached") throw new Error("fixture");
      state.authorities.item.source.sources[0].sourceUrl = filingMedium === "electronic"
        ? "https://www.canlii.org/en/ca/scc/doc/2024/2024scc1/2024scc1.html" : null;
      state.authorityOrder = ["item"];
      state.bindings["source:item"] = { kind: "local-file", handleId: "item", lastSeen: {
        name: "item.pdf", size: decision.length, modified: 1, sha256: sha256(decision) } };
      state = reduceAuthoritiesDraft(state, { type: "set-profile", profileId: "federal-court" });
      state.settings.bookRole = "applicant";
      state = reduceAuthoritiesDraft(state, { type: "set-settings", settings: { filingMedium } });
      const built = await buildAuthorities({ draft: state, title: "Full authorities",
        workProduct: { id: `full-${filingMedium}`, revision: 1 }, sources: { "source:item": {
          bytes: decision, pageTextByPage: ["Headnote", "[1] Reasons", "[10] cited", "[11]"] } } });
      expect((await PDFDocument.load(built.artifacts.book!.bytes)).getPageCount()).toBe(6);
    }
  });

  it("resolves printed report pages from the shared map and never guesses physical offsets", async () => {
    const raw = await sourcePdf("Decision", Array.from({ length: 9 }, () =>
      [400, 500] as [number, number]));
    const labelled = await withDecimalPageLabels(raw, 145);
    const texts = ["Headnote", "[1] Reasons", "[2] omitted", "[3] omitted",
      "Printed 149", "Printed 150", "Printed 151", "Printed 152", "Printed 153"];
    const build = async (decision: Uint8Array, id: string, pageLabels?: string[]) => {
      let state = withForm66(createAuthoritiesDraft({ kind: "manual" }, {}, "book"));
      state.authorities.item = attached("item", "case", "2026 SCC 1", "R v Labelled",
        "source:item", decision);
      state.authorities.item.locators = [{ kind: "page", label: "150" }];
      if (state.authorities.item.source.kind !== "attached") throw new Error("fixture");
      state.authorities.item.source.sources[0].sourceUrl =
        "https://www.canlii.org/en/ca/scc/doc/2026/2026scc1/2026scc1.html";
      state.authorityOrder = ["item"];
      state.bindings["source:item"] = { kind: "local-file", handleId: id, lastSeen: {
        name: `${id}.pdf`, size: decision.length, modified: 1, sha256: sha256(decision) } };
      state = reduceAuthoritiesDraft(state, { type: "set-profile", profileId: "federal-court" });
      state.settings.bookRole = "applicant";
      state = reduceAuthoritiesDraft(state, { type: "set-settings",
        settings: { filingMedium: "paper" } });
      return buildAuthorities({ draft: state, title: "Report pagination",
        workProduct: { id, revision: 1 }, sources: { "source:item": {
          bytes: decision, pageTextByPage: texts, pageBindings: resolvePdfPagination(pageLabels ?? [], []) } } });
    };

    const extract = await PDFDocument.load((await build(labelled, "labelled",
      Array.from({ length: 9 }, (_, index) => String(145 + index))))
      .artifacts.book!.bytes);
    expect(extract.getPageCount()).toBe(7);
    [1, 2, 5, 6, 7].forEach((pageNumber, index) =>
      expect(pageContent(extract, extract.getPage(index + 2)).toUpperCase())
        .toContain(pdfTextHex(`Decision page ${pageNumber}`)));
    expect((await PDFDocument.load((await build(raw, "unlabelled")).artifacts.book!.bytes))
      .getPageCount()).toBe(11);
  });

  it("identifies Federal book filers and colours only paper appeal covers", async () => {
    const casePdf = await sourcePdf("Grant", [[400, 500]]);
    const legislationPdf = await sourcePdf("Act", [[500, 600]]);
    const sources = { "source:grant": { bytes: casePdf },
      "source:fca": { bytes: legislationPdf } };
    const colours = {
      joint: [128 / 255, 0, 32 / 255], appellant: [245 / 255, 245 / 255, 220 / 255],
      respondent: [169 / 255, 209 / 255, 142 / 255],
      intervener: [159 / 255, 197 / 255, 220 / 255],
    } as const;
    for (const profileId of ["federal-court-appeal", "federal-court-of-appeal"] as const) {
      for (const bookRole of Object.keys(colours) as Array<keyof typeof colours>) {
        let state = reduceAuthoritiesDraft(draft(casePdf, legislationPdf),
          { type: "set-profile", profileId });
        state = reduceAuthoritiesDraft(state, { type: "set-settings",
          settings: { filingMedium: "paper", bookRole } });
        const result = await buildAuthorities({ draft: state, title: "Federal appeal book",
          workProduct: { id: `paper-${profileId}-${bookRole}`, revision: 1 }, sources });
        const book = await PDFDocument.load(result.artifacts.book!.bytes);
        const cover = pageContent(book, book.getPage(0));
        const back = pageContent(book, book.getPage(book.getPageCount() - 1));
        const line = bookRole === "joint" ? "Filed jointly"
          : `Filed by ${bookRole[0].toUpperCase()}${bookRole.slice(1)}`;
        expect(cover.toUpperCase()).toContain(
          Buffer.from(line, "latin1").toString("hex").toUpperCase());
        expect(pageHasRgb(cover, colours[bookRole])).toBe(true);
        expect(pageHasRgb(back, colours[bookRole])).toBe(true);
      }
    }

    let federal = reduceAuthoritiesDraft(draft(casePdf, legislationPdf),
      { type: "set-profile", profileId: "federal-court" });
    federal = reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { filingMedium: "paper", bookRole: "respondent" } });
    const result = await buildAuthorities({ draft: federal, title: "Federal Court book",
      workProduct: { id: "paper-federal", revision: 1 }, sources });
    const federalBook = await PDFDocument.load(result.artifacts.book!.bytes);
    const cover = pageContent(federalBook, federalBook.getPage(0));
    expect(cover.toUpperCase()).toContain(
      Buffer.from("Filed by Respondent", "latin1").toString("hex").toUpperCase());
    expect(Object.values(colours).some((colour) => pageHasRgb(cover, colour))).toBe(false);
  });

  it("builds filing-sized FC and FCA volumes with global tabs, pages, and local links",
    async () => {
    const alphaPdf = await sourcePdf("Alpha authority",
      Array.from({ length: 497 }, () => [400, 500] as [number, number]));
    const zuluPdf = await sourcePdf("Zulu authority", [[400, 500], [400, 500]]);
    const base = withForm66(createAuthoritiesDraft({ kind: "manual" }, {}, "book"));
    base.authorities.alpha = attached("alpha", "case", "2026 SCC 1", "Alpha v Canada",
      "source:alpha", alphaPdf);
    base.authorities.zulu = attached("zulu", "case", "2026 SCC 2", "Zulu v Canada",
      "source:zulu", zuluPdf);
    base.authorityOrder = ["alpha", "zulu"];
    for (const [id, bytes] of [["alpha", alphaPdf], ["zulu", zuluPdf]] as const)
      base.bindings[`source:${id}`] = { kind: "local-file", handleId: id, lastSeen: {
        name: `${id}.pdf`, size: bytes.length, modified: 1, sha256: sha256(bytes) } };
    const sources = { "source:alpha": { bytes: alphaPdf }, "source:zulu": { bytes: zuluPdf } };

    for (const profileId of ["federal-court", "federal-court-of-appeal"] as const) {
      const state = reduceAuthoritiesDraft(base, { type: "set-profile", profileId });
      state.settings.bookRole ??= "applicant";
      const built = await buildAuthorities({ draft: state, title: "Long Federal book",
        workProduct: { id: `long-${profileId}`, revision: 1 }, sources });
      expect(Object.keys(built.artifacts).sort()).toEqual(["book", "book-2"]);
      expect(Object.keys(built.receipt.outputs).sort()).toEqual(["book", "book-2"]);
      const books = await Promise.all(["book", "book-2"].map((role) =>
        PDFDocument.load(built.artifacts[role]!.bytes)));
      expect(books.map((book) => book.getPageCount())).toEqual([500, 5]);
      const title = profileId === "federal-court" ? "Book of Authorities"
        : "Book of Statutes, Regulations and Authorities";
      for (const [index, book] of books.entries()) {
        expect(book.getTitle()).toBe(title);
        const cover = pageContent(book, book.getPage(0)).toUpperCase();
        const back = pageContent(book, book.getPage(book.getPageCount() - 1)).toUpperCase();
        expect(cover).toContain(pdfTextHex(`Volume ${index + 1} of 2`));
        expect(back).toContain(pdfTextHex(`Volume ${index + 1} of 2`));
        const toc = book.getPage(1), content = pageContent(book, toc).toUpperCase();
        for (const value of ["Tab 1", "Alpha v Canada", "3–499", "Tab 2",
          "Zulu v Canada", "503–504"]) expect(content).toContain(pdfTextHex(value));
        const internal = toc.node.lookup(PDFName.of("Annots"), PDFArray).asArray()
          .map((ref) => book.context.lookup(ref, PDFDict))
          .filter((annotation) => annotation.has(PDFName.of("Dest")));
        expect(internal).toHaveLength(1);
        expect(String(internal[0].lookup(PDFName.of("Dest"), PDFArray).get(0)))
          .toBe(String(book.getPage(2).ref));
        expect(pageContent(book, book.getPage(2)).toUpperCase())
          .toContain(pdfTextHex(index ? "503" : "3"));
        const root = book.catalog.lookup(PDFName.of("Outlines"), PDFDict)
          .lookup(PDFName.of("First"), PDFDict);
        const local = root.lookup(PDFName.of("Next"), PDFDict)
          .lookup(PDFName.of("Next"), PDFDict).lookup(PDFName.of("First"), PDFDict);
        expect(local.lookup(PDFName.of("Title"), PDFHexString).decodeText())
          .toContain(`Tab ${index + 1}`);
        expect(local.has(PDFName.of("Next"))).toBe(false);
        expect(book.catalog.lookup(PDFName.of("PageLabels"), PDFDict)
          .lookup(PDFName.of("Nums"), PDFArray).lookup(1, PDFDict)
          .lookup(PDFName.of("St"), PDFNumber).asNumber()).toBe(index ? 501 : 1);
      }
      expect(built.artifacts.book!.filename).toContain(".volume-1-of-2.pdf");
      expect(built.artifacts["book-2"]!.filename).toContain(".volume-2-of-2.pdf");
    }

    const customIndex = await sourcePdf("Custom index", [[612, 792]]);
    let custom = reduceAuthoritiesDraft(base, { type: "set-profile",
      profileId: "federal-court" });
    custom.settings.bookRole = "applicant";
    custom = reduceAuthoritiesDraft(custom, { type: "set-book-part", slot: "index",
      pdf: { bindingRole: "book:index", filename: "index.pdf",
        sourceSha256: sha256(customIndex) }, binding: { kind: "local-file",
        handleId: "index", lastSeen: { name: "index.pdf", size: customIndex.length,
          modified: 1, sha256: sha256(customIndex) } } });
    await expect(buildAuthorities({ draft: custom, title: "Custom long Federal book",
      workProduct: { id: "custom-long", revision: 1 },
      sources: { ...sources, "book:index": { bytes: customIndex } } }))
      .rejects.toThrow("Remove the custom index");
  });

  it("emits a versionable copy of an imported DOCX with native TA and TOA fields", async () => {
    const citation = "R v Grant, 2009 SCC 32", reporter = "[2009] 2 SCR 353";
    const source = await Packer.toBuffer(new WordDocument({ sections: [{ children: [
      new Paragraph({ children: [new TextRun(citation)] }),
      new Paragraph({ children: [new TextRun(reporter)] }),
    ] }] }));
    const digest = sha256(source);
    const imported = { kind: "document" as const, bindingRole: "source" as const,
      filename: "Factum.docx", fileType: "docx" as const,
      snapshot: { documentId: "factum", versionId: "v3", sha256: digest } };
    const direct = createAuthoritiesDraft(imported, { source: { kind: "document",
      documentId: "factum", version: { versionId: "v3", sha256: digest } } });
    Object.assign(direct, { outputMode: "table", insertIntoDocument: true,
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [], text: citation, occurrenceIds: ["grant:0"] },
      { id: "body:1", kind: "body", ordinal: 1, footnoteId: null,
        footnoteRefs: [], pageNumbers: [], text: reporter, occurrenceIds: ["grant:1"] }],
      occurrences: { "grant:0": { id: "grant:0", unitId: "body:0", start: 0,
        end: citation.length, text: citation, kind: "case", citation,
        authoritySpan: { start: 0, end: citation.length, text: citation },
        coreSpan: { start: 0, end: citation.length, text: citation }, pinpointSpan: null,
        authorityId: "grant", reference: null, pinpoints: [], evidenceIds: [],
        sourceTextSha256: sha256(citation), localOrdinal: 0, reviewed: true },
      "grant:1": { id: "grant:1", unitId: "body:1", start: 0,
        end: reporter.length, text: reporter, kind: "case", citation: reporter,
        authoritySpan: { start: 0, end: reporter.length, text: reporter },
        coreSpan: { start: 0, end: reporter.length, text: reporter }, pinpointSpan: null,
        authorityId: "grant", reference: null, pinpoints: [], evidenceIds: [],
        sourceTextSha256: sha256(reporter), localOrdinal: 0, reviewed: true } },
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
    expect(xml).toContain(
      ' TA \\l &quot;R v Grant, 2009 SCC 32, [2009] 2 SCR 353&quot;',
    );
    // Word builds a table for one category per field: here, its cases.
    expect(xml).toContain(' TOA \\h \\c &quot;1&quot; ');
    expect(result.receipt.outputs["annotated-document"]?.sha256)
      .toBe(result.artifacts["annotated-document"]?.sha256);

    const linked = structuredClone(direct);
    linked.settings.tableDelivery = "linked-append";
    linked.settings.tableOrder = "first-reference";
    linked.authorities.grant.displayName = "Grant (custom)";
    linked.authorities.grant.source = { kind: "pending-canlii", authorityKey: "grant",
      pageUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html",
      pdfUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf" };
    const linkedResult = await buildAuthorities({ draft: linked, title: "Factum",
      workProduct: { id: "authorities-docx", revision: 3 }, sources: { source: {
        bytes: source, resolved: { kind: "document", documentId: "factum",
          versionId: "v3", filename: "Factum.docx", sha256: digest },
      } } });
    const linkedXml = await (await JSZip.loadAsync(
      linkedResult.artifacts["annotated-document"]!.bytes))
      .file("word/document.xml")!.async("string");
    const linkedTableZip = await JSZip.loadAsync(linkedResult.artifacts.table!.bytes);
    const linkedTableXml = await linkedTableZip.file("word/document.xml")!.async("string");
    const linkedTableRels = await linkedTableZip.file("word/_rels/document.xml.rels")!
      .async("string");
    expect(linkedXml).toContain("TABLE OF AUTHORITIES");
    expect(linkedXml).toContain("Grant (custom)");
    expect(linkedXml).toContain("Grant (custom), R v Grant, 2009 SCC 32, [2009] 2 SCR 353");
    expect(linkedXml).toContain("HYPERLINK &quot;https://www.canlii.org/");
    expect(linkedXml).not.toContain(" TA \\l ");
    expect(linkedTableXml).toContain("w:hyperlink");
    expect(linkedTableRels).toContain("https://www.canlii.org/");
    expect(linkedTableXml).toContain("1. ");
    expect(linkedTableXml).not.toContain("Cited at");
    expect(linkedTableXml).not.toContain("Open source");
    expect(linkedResult.artifacts["annotated-document"]?.receipt.steps)
      .toEqual(["Appended the linked Table of Authorities to the Word document"]);

    direct.occurrences["grant:0"].reviewed = false;
    const unconfirmed = await buildAuthorities({ draft: direct, title: "Factum",
      workProduct: { id: "authorities-docx", revision: 3 }, sources: { source: {
        bytes: source, resolved: { kind: "document", documentId: "factum",
          versionId: "v3", filename: "Factum.docx", sha256: digest },
      } } });
    const unconfirmedXml = await (await JSZip.loadAsync(
      unconfirmed.artifacts["annotated-document"]!.bytes)).file("word/document.xml")!.async("string");
    expect(unconfirmedXml).toContain(" TA \\l ");
  });
});
