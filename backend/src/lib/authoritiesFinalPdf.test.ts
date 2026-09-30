import * as pdf from "pdf-lib";
import { expect, it } from "vitest";
import { assembleFinalAuthoritiesPdf } from "./authoritiesFinalPdf";
import { createAuthoritiesDraft } from "./authoritiesDomain";

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
