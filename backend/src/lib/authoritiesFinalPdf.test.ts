import * as pdf from "pdf-lib";
import { expect, it } from "vitest";
import type { AuthoritiesDraft } from "mike/shared/authorities-contract.d.ts";
import { assembleFinalAuthoritiesPdf, briefOccurrencePages } from "./authoritiesFinalPdf";
import { createAuthoritiesDraft } from "./authoritiesDomain";
import { pdfAssembly } from "mike/shared/runtime/pdfAssembly.mjs";

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

/** A draft of footnotes, each citing one authority. */
function notes(...entries: Array<[text: string, citation: string]>) {
  const units = entries.map(([text, citation], index) => ({ id: `footnote:${index + 1}`, footnoteId: String(index + 1),
    text, occurrenceIds: [`c${index}`], citation }));
  return { units, occurrences: Object.fromEntries(units.map(({ text, citation }, index) => {
    const start = text.indexOf(citation);
    return [`c${index}`, { id: `c${index}`, start, end: start + citation.length, text: citation }];
  })) } as unknown as AuthoritiesDraft;
}

it("places citations followed by tab references when one only matches the brief's own table", () => {
  const draft = notes(["See Cedar Act, RSA 2000, c C-1 at s 4.", "Cedar Act, RSA 2000, c C-1"],
    ["Compare Dogwood v Elm, 2003 SCC 3 at para 9.", "Dogwood v Elm, 2003 SCC 3"]);
  const pages = briefOccurrencePages(draft, [
    // The Word copy's PDF: the first citation reads differently there, the second has its tab after it,
    "1 See Cedar Act, RSA 2000, ch C-1 [Tab 1] at s 4.",
    "2 Compare Dogwood v Elm, 2003 SCC 3 [Tab 2] at para 9.",
    // and the table of authorities Word built lists both after every citation.
    "Table of Authorities Statutes Cedar Act, RSA 2000, c C-1 ..... 1 Cases Dogwood v Elm, 2003 SCC 3 ..... 2",
  ]);
  expect(pages.get("c1")).toBe(2);
});
