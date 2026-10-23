import { resolvePdfPagination } from "./pdfPagination";
import JSZip from "jszip";
import { Document as WordDocument, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName,
  PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { authoritiesTextRoles, authorityFilingTargets, authorityPassageRequests, authorityPassageTargets,
  buildAuthorities, renderAuthoritySourcePdf, statuteExcerptSummary } from "./authoritiesBuild";
import { attachedAuthoritySources, createAuthoritiesDraft as createDraft, reduceAuthoritiesDraft, type AuthoritiesDraft,
  type AuthorityIdentity } from "./authoritiesDomain";
import { sha256 } from "./hash";
import { fit, renderAuthoritiesBook } from "mike/shared/runtime/authoritiesBook.mjs";
import { filingLinkUrl } from "./authoritiesFinalPdf";
import { createAuthoritiesPreparation } from "./authoritiesPreparation";
import type { NativePdfPassageGeometry } from "./structureNative";
import { pdfAssembly } from "mike/shared/runtime/pdfAssembly.mjs";
import * as pdfLibrary from "pdf-lib";

/** These drafts lay their books out page for page, without TAB pages and with the pages in the index:
 *  the tests below are about what each authority's pages hold, not the tabs between them. */
const createAuthoritiesDraft = (...input: Parameters<typeof createDraft>) => {
  const draft = createDraft(...input);
  Object.assign(draft.settings, { tabPages: false, indexShows: "tabs-and-pages" });
  return draft;
};

async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const document = await task.promise, pages: string[] = [];
    for (let page = 1; page <= document.numPages; page++)
      pages.push((await (await document.getPage(page)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" "));
    return pages.join(" ");
  } finally { await task.destroy(); }
}

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

/** What a page draws: its content, with each form it shows (a header or a page number) and each
 *  field's appearance (a cover's values) where they stand. */
function pageContent(document: PDFDocument, page: ReturnType<PDFDocument["getPage"]>) {
  const read = (item: unknown) => Buffer.from(decodePDFRawStream(item instanceof PDFRawStream ? item
    : document.context.lookup(item as PDFRef, PDFRawStream)).decode()).toString("latin1");
  const shift = (content: string, x: number, y: number) => content.replace(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/gu,
    (_, left, bottom) => `1 0 0 1 ${Number(left) + x} ${Number(bottom) + y} Tm`);
  const contents = page.node.Contents();
  const items = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const forms = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const drawn = items.map(read).join("\n").replace(/1 0 0 1 ([-\d.]+) ([-\d.]+) cm\s+\/(\S+) Do/gu,
    (whole, x, y, name) => forms?.has(PDFName.of(name)) ? shift(read(forms.get(PDFName.of(name))), Number(x), Number(y)) : whole);
  const fields = (page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? [])
    .map((ref) => document.context.lookup(ref, PDFDict))
    .filter((annotation) => annotation.get(PDFName.of("Subtype"))?.toString() === "/Widget")
    .map((widget) => {
      const [x, y] = widget.lookup(PDFName.of("Rect"), PDFArray).asArray().map((value) => Number(value.toString()));
      return shift(read(widget.lookup(PDFName.of("AP"), PDFDict).get(PDFName.of("N"))), x, y);
    });
  return [drawn, ...fields].join("\n");
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

/** What a viewer would show beside a mark: an author or a comment. Marks carry neither. */
const annotNotes = (document: PDFDocument, pageIndex: number) =>
  pageAnnots(document, pageIndex).filter((annot) => annot.has(PDFName.of("T")) || annot.has(PDFName.of("Contents")));

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
      // Word is asked to refresh only Word's own table on opening: its page numbers are Word's layout.
      expect((await zip.file("word/settings.xml")!.async("string")).includes("w:updateFields"), at)
        .toBe(marked && tableDelivery === "native-append");
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
    // The book in the order listed, as one list.
    outputMode: "both", settings: { ...createAuthoritiesDraft({ kind: "manual" }).settings,
      tableOrder: "custom", grouping: "none" },
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
  it("keeps prepared OCR text when a cited pinpoint cannot be placed", async () => {
    const bytes = await sourcePdf("Invented scan", [[400, 500]]);
    const binding = { kind: "local-file" as const, handleId: "scan", lastSeen: {
      name: "permit.pdf", size: bytes.length, modified: 1, sha256: sha256(bytes) } };
    const state = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
      filename: "submission.pdf", fileType: "pdf", snapshot: null }, { source: binding });
    state.bindings.scan = binding;
    state.settings.scannedPdfPolicy = "cited-pages";
    state.authorities.permit = attached("permit", "case", "2034 ABKB 63", "Fenwick v Permit Board", "scan", bytes);
    state.authorities.permit.locators = [{ kind: "paragraph", label: "999" }];
    state.authorityOrder = ["permit"];
    const recognized = "A permit remains effective until the board gives written notice.";
    const input = { draft: state, title: "Permits", workProduct: { id: "ocr-export", revision: 1 },
      sources: { source: { bytes }, scan: { bytes, pageTextByPage: [recognized], ocrTextByPage: [recognized] } } };
    expect(await pdfText((await buildAuthorities(input)).artifacts.book!.bytes)).toContain(recognized);
    state.settings.scannedPdfPolicy = "page-margin";
    expect(await pdfText((await buildAuthorities(input)).artifacts.book!.bytes)).not.toContain(recognized);
  });

  it("renders publisher text containing Unicode punctuation and multiline titles", async () => {
    const { bytes } = await renderAuthoritySourcePdf({ kind: "case", name: "A ‑ B\r\nSecond\tline",
      citation: "2026 SCC 16", date: null, sourceUrl: null,
      text: "The Court said “source text” — not source metadata." });
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(1);
    const font = await document.embedFont(StandardFonts.Helvetica);
    expect(fit(font, "A ‑ B\r\nSecond\tline", 12, 400)).toBe("A - B Second line");
  });

  it("lists a long citation in full in the book index, wrapped beneath its tab", async () => {
    const pdf = await sourcePdf("Article", [[400, 500]]);
    const citation = "Wren Halloway & Pell Ostrander, \"Not Quite Idle: Delay, Notice and the Licensing Boards of the "
      + "Northern Basins Reconsidered\" (2034) 41:2 Imaginary Journal of Waterway Administration 233";
    const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.wren = attached("wren", "commentary", citation, null, "wren", pdf);
    state.authorityOrder = ["wren"];
    state.bindings.wren = { kind: "local-file", handleId: "wren", lastSeen: {
      name: "wren.pdf", size: pdf.length, modified: 1, sha256: sha256(pdf) } };
    const built = await buildAuthorities({ draft: state, title: "Article authorities",
      workProduct: { id: "long-citation", revision: 1 }, sources: { wren: { bytes: pdf } } });
    const book = await PDFDocument.load(built.artifacts.book!.bytes);
    const index = pageContent(book, book.getPage(1)).toUpperCase();
    // Never cut short: the citation runs on to further lines, its words whole and in order.
    const lines = [...index.matchAll(/<([0-9A-F]+)> TJ/gu)].map(([, hex]) => Buffer.from(hex, "hex").toString("latin1"))
      .filter((line) => citation.includes(line.trim()) && line.trim().length > 20);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ").replace(/\s+/gu, " ")).toBe(citation);
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
    // The index cites it in full, its style of cause in italics.
    const index = pageContent(book, book.getPage(1)).toUpperCase();
    expect(index).toMatch(new RegExp(`/TIMES-ITALIC-\\d+ [\\d.]+ TF\\s+[\\s\\S]*?<${pdfTextHex("R v Grant")}> TJ`, "u"));
    expect(index).toContain(pdfTextHex(", 2009 SCC 32"));
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
    expect(annotNotes(markedBook, 2)).toEqual([]);
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
    // The book's tabs follow the table's order: as first cited, the uncited after.
    expect(automatic.receipt.authorities.map(({ id }) => id)).toEqual(["zulu", "alpha", "omitted"]);
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
        ["alpha", "Alpha v Test, 2024 ABKB 1", "Tab 2"],
        ["omitted", "Omitted v Test, 2024 ABKB 3", "Not reproduced"]]);
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

  it("exports an explicit incomplete draft without the PDFs its court leaves out, fixed labels, and source guards", async () => {
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
    expect(result.artifacts.book!.filename).toBe("Working draft.book-of-authorities.pdf");
    expect(book.getTitle()).not.toMatch(/incomplete/iu);
    // The court leaves a missing source out of the book, as the Missing PDFs warning says;
    // every tab keeps its label.
    expect(result.receipt.authorities.filter(({ excluded }) => !excluded).map(({ tab }) => tab))
      .toEqual(["Schedule A", "Schedule B"]);
    expect(pageContent(book, book.getPage(2)).toUpperCase()).not.toContain(pdfTextHex("unavailable"));
    expect(pageContent(book, book.getPage(0)).toUpperCase()).not.toContain(pdfTextHex("NOT FOR FILING"));
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
    for (const value of ["Court File No.", "T-123-26", "FEDERAL COURT", "BETWEEN:",
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
    // A link's address is plain ASCII, as viewers read it.
    expect(external?.lookup(PDFName.of("A"), PDFDict)
      .lookup(PDFName.of("URI"), PDFString).decodeText())
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

  it("puts a short statute in whole unless an excerpt is chosen", async () => {
    const statute = await sourcePdf("Short Act", Array.from({ length: 4 }, () => [400, 500] as [number, number]));
    let state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    state.authorities.act = attached("act", "legislation", "SA 2031, c W-4", "Short Act", "act", statute);
    state.authorities.act.locators = [{ kind: "section", label: "3" }];
    state.authorityOrder = ["act"];
    state.bindings.act = { kind: "local-file", handleId: "act", lastSeen: { name: "act.pdf", size: statute.length,
      modified: 1, sha256: sha256(statute) } };
    const passageGeometry: NativePdfPassageGeometry = { ...paragraphGeometry(statute), targets: [{ id: "passage:1",
      locatorKind: "section", locator: "3", status: "found", pages: [{ pageNumber: 3, width: 400, height: 500,
        source: "native", passageRects: [[36, 60, 320, 90]] }], quotes: [] }] };
    const pages = async (draft: AuthoritiesDraft) => (await PDFDocument.load((await buildAuthorities({ draft,
      title: "Short", workProduct: { id: "short", revision: 1 }, sources: { act: { bytes: statute, passageGeometry } } }))
      .artifacts.book!.bytes)).getPageCount();
    expect(await pages(state)).toBe(6);
    state = reduceAuthoritiesDraft(state, { type: "set-authority-excerpt", authorityId: "act", excerpt: true });
    expect(await pages(state)).toBe(4);
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

  it("lists each authority in Word's table as the brief first cites it", async () => {
    // Two styles of cause on one citation, a citation the brief gives alone with its source's name, a
    // work cited by its link in angle brackets, and a CanLII ID whose court follows its pinpoint.
    const texts = ["R v Ash, 2030 ABKB 1 at para 4.", "R v AB, 2030 ABKB 1 at para 9.", "2031 ONCA 7 at para 2.",
      "Jo Pine, “Moss”, online: <example.test/moss>.", "Oak v Gum, 2029 CanLII 5 at 3 (SCC)."];
    const spans: Array<[authority: string, start: number, core: number, end: number]> = [
      ["ash", 0, 9, 20], ["ash", 0, 8, 19], ["elm", 0, 0, 11], ["pine", 0, 26, 43], ["oak", 0, 11, 24]];
    const source = await Packer.toBuffer(new WordDocument({ sections: [{ children: texts.map((text) => new Paragraph(text)) }] }));
    const digest = sha256(source);
    const imported = { kind: "document" as const, bindingRole: "source" as const, filename: "Brief.docx", fileType: "docx" as const,
      snapshot: { documentId: "brief", versionId: "v1", sha256: digest } };
    const state = createAuthoritiesDraft(imported, { source: { kind: "document", documentId: "brief",
      version: { versionId: "v1", sha256: digest } } });
    const span = (text: string, start: number, end: number) => ({ start, end, text: text.slice(start, end) });
    Object.assign(state, { outputMode: "table", insertIntoDocument: true,
      units: texts.map((text, ordinal) => ({ id: `body:${ordinal}`, kind: "body", ordinal, footnoteId: null, footnoteRefs: [],
        pageNumbers: [], text, occurrenceIds: [`o${ordinal}`] })),
      occurrences: Object.fromEntries(spans.map(([authority, start, core, end], ordinal) => [`o${ordinal}`, {
        id: `o${ordinal}`, unitId: `body:${ordinal}`, start, end, text: texts[ordinal].slice(start, end),
        kind: authority === "pine" ? "commentary" : "case", citation: texts[ordinal].slice(core, end),
        authoritySpan: span(texts[ordinal], start, end), coreSpan: span(texts[ordinal], core, end), pinpointSpan: null,
        authorityId: authority, reference: null, pinpoints: [], evidenceIds: [], sourceTextSha256: sha256(texts[ordinal]),
        localOrdinal: 0, reviewed: true }])),
      authorities: Object.fromEntries([["ash", "case", "2030 ABKB 1", null], ["elm", "case", "2031 ONCA 7", "Elm v Fir"],
        ["pine", "commentary", "example.test/moss", null], ["oak", "case", "2029 CanLII 5 (SCC)", "Oak v Gum"]].map(([id, kind, citation, name]) => [id, { id, key: id, kind, citation,
        name, displayName: null, evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
        source: { kind: "unresolved" } }])),
      authorityOrder: ["ash", "elm", "pine", "oak"] });
    const result = await buildAuthorities({ draft: state, title: "Brief", workProduct: { id: "entries", revision: 1 },
      sources: { source: { bytes: source, resolved: { kind: "document", documentId: "brief", versionId: "v1",
        filename: "Brief.docx", sha256: digest } } } });
    const xml = (await (await JSZip.loadAsync(result.artifacts["annotated-document"]!.bytes)).file("word/document.xml")!
      .async("string")).replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    // A field's code runs on across its runs, the style of cause in an italic one.
    const codes = xml.replace(/<\/w:instrText><\/w:r><w:r>(?:<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<w:instrText[^>]*>/gu, "");
    const entries = [...codes.matchAll(/ TA \\l "((?:\\.|[^"\\])*)"/gu)].map(([, entry]) => entry.replaceAll("\\“", "“")
      .replaceAll("\\”", "”"));
    expect(entries.sort()).toEqual(["Elm v Fir, 2031 ONCA 7", "Jo Pine, “Moss”, online: example.test/moss",
      "Oak v Gum, 2029 CanLII 5 (SCC)", "R v Ash, 2030 ABKB 1"]);
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
    expect(xml).toContain('<w:r><w:rPr><w:i></w:i></w:rPr><w:instrText xml:space="preserve">R v Grant</w:instrText></w:r>'
      + '<w:r><w:instrText xml:space="preserve">, 2009 SCC 32, [2009] 2 SCR 353&quot;');
    // Word builds a table for one category per field: here, its cases.
    expect(xml).toContain(' TOA \\c &quot;1&quot; ');
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
    // The citation in black, its link printed in link blue.
    expect(linkedXml).toContain('<w:rPr><w:i></w:i></w:rPr><w:t>Grant (custom)</w:t>');
    expect(linkedXml).toContain("<w:t>, R v Grant, 2009 SCC 32, [2009] 2 SCR 353</w:t>");
    // Its link is printed under it, for a reader on paper.
    expect(linkedXml).toContain("<w:t>https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html</w:t>");
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
