import * as pdf from "pdf-lib";
import { expect, it } from "vitest";
import { assembleFinalAuthoritiesPdf } from "./authoritiesFinalPdf";
import { createAuthoritiesDraft } from "./authoritiesDomain";
import { pdfAssembly } from "./pdfAssembly";

it("retains named and GoTo-action bookmarks in the brief and appended book", async () => {
  const source = await pdf.PDFDocument.create(); source.addPage(); source.addPage();
  const sourceDestination = source.context.obj([source.getPage(1).ref, "Fit"]);
  source.catalog.set(pdf.PDFName.of("Dests"), source.context.obj({ opening: sourceDestination }));
  source.catalog.set(pdf.PDFName.of("Outlines"), source.context.obj({ First: {
    Title: pdf.PDFString.of("Brief section"), A: { S: "GoTo", D: pdf.PDFName.of("opening") },
  } }));
  const book = await pdf.PDFDocument.create(); book.addPage();
  book.catalog.set(pdf.PDFName.of("Names"), book.context.obj({ Dests: { Names: [
    pdf.PDFString.of("section"), { D: [book.getPage(0).ref, "Fit"] },
  ] } }));
  book.catalog.set(pdf.PDFName.of("Outlines"), book.context.obj({ First: {
    Title: pdf.PDFString.of("Book section"), Dest: pdf.PDFString.of("section"),
  } }));
  const draft = createAuthoritiesDraft({ kind: "manual" });
  draft.settings.linkTabs = false; draft.settings.linkPinpoints = false;
  const result = await assembleFinalAuthoritiesPdf({ draft, title: "Named destinations",
    workProduct: { id: "named", revision: 1 } }, await source.save(), [{ role: "book", bytes: Buffer.from(await book.save()) }]);
  const reopened = await pdf.PDFDocument.load(result.bytes);
  const first = reopened.catalog.lookup(pdf.PDFName.of("Outlines"), pdf.PDFDict)
    .lookup(pdf.PDFName.of("First"), pdf.PDFDict);
  const briefSection = first.lookup(pdf.PDFName.of("First"), pdf.PDFDict);
  expect(briefSection.lookup(pdf.PDFName.of("Title"), pdf.PDFHexString).decodeText()).toBe("Brief section");
  expect(String(briefSection.lookup(pdf.PDFName.of("Dest"), pdf.PDFArray).get(0)))
    .toBe(String(reopened.getPage(1).ref));
  const bookSection = first.lookup(pdf.PDFName.of("Next"), pdf.PDFDict)
    .lookup(pdf.PDFName.of("First"), pdf.PDFDict);
  expect(bookSection.lookup(pdf.PDFName.of("Title"), pdf.PDFHexString).decodeText()).toBe("Book section");
  expect(String(bookSection.lookup(pdf.PDFName.of("Dest"), pdf.PDFArray).get(0)))
    .toBe(String(reopened.getPage(2).ref));
});

it("outlines a brief without bookmarks by its headings, then the book's tabs", async () => {
  const brief = await pdf.PDFDocument.create(); brief.addPage(); brief.addPage(); brief.addPage();
  const book = await pdf.PDFDocument.create(); book.addPage(); book.addPage();
  pdfAssembly(pdf).applyOutlines(book, [{ title: "Tab 1 — Harbour Board v Tug", pageIndex: 1 }], false);
  const draft = createAuthoritiesDraft({ kind: "document", bindingRole: "source", filename: "Factum.pdf",
    fileType: "pdf", snapshot: null }, { source: { kind: "local-file", handleId: "brief", lastSeen: {
    name: "Factum.pdf", size: 1, modified: 1, sha256: "b".repeat(64) } } });
  draft.settings.linkTabs = false; draft.settings.linkPinpoints = false;
  const outline = [{ kind: "heading" as const, level: 0, title: "PART I - FACTS", start: 0, pageIndex: 0 },
    { kind: "heading" as const, level: 1, title: "A. The tow", start: 40, pageIndex: 1 },
    { kind: "heading" as const, level: 0, title: "PART II - ISSUES", start: 90, pageIndex: 2 }];
  const result = await assembleFinalAuthoritiesPdf({ draft, title: "Outlined", workProduct: { id: "outlined", revision: 1 },
    sources: { source: { outline } } }, await brief.save(), [{ role: "book", bytes: Buffer.from(await book.save()) }]);
  const reopened = await pdf.PDFDocument.load(result.bytes);
  expect(pdfAssembly(pdf).readOutlines(reopened)).toEqual([
    { title: "Brief", pageIndex: 0, children: [
      { title: "PART I - FACTS", pageIndex: 0, children: [{ title: "A. The tow", pageIndex: 1 }] },
      { title: "PART II - ISSUES", pageIndex: 2 }] },
    { title: "Book of authorities", pageIndex: 3, children: [{ title: "Tab 1 — Harbour Board v Tug", pageIndex: 4 }] }]);
});
