import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName,
  PDFNumber, PDFRawStream, StandardFonts, degrees } from "pdf-lib";
import { expect, it } from "vitest";
import * as pdf from "pdf-lib";
import { pdfAssembly } from "./pdfAssembly";
const { addInternalLink, applyOcrText, applyOutlines, applyPageLabels, drawPageNumber, assemble, appendPages } = pdfAssembly(pdf);

it("preserves local named destinations through repeated page copies without changing remote links", async () => {
  const original = await PDFDocument.create();
  original.addPage(); original.addPage();
  const destination = original.context.obj([original.getPage(1).ref, "XYZ", null, 400, null]);
  original.catalog.set(PDFName.of("Dests"), original.context.obj({ legacy: destination }));
  original.catalog.set(PDFName.of("Names"), original.context.obj({ Dests: { Kids: [{ Names: [
    pdf.PDFString.of("section"), { D: destination }, PDFHexString.fromText("hex"), destination,
  ] }] } }));
  for (const entry of [
    { Dest: PDFName.of("legacy") }, { Dest: pdf.PDFString.of("section") },
    { A: { S: "GoTo", D: PDFHexString.fromText("hex") } }, { Dest: destination },
    { A: { S: "GoToR", F: pdf.PDFString.of("other.pdf"), D: pdf.PDFString.of("section") } },
    { A: { S: "URI", URI: pdf.PDFString.of("https://example.test") } },
  ]) original.getPage(0).node.addAnnot(original.context.register(original.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [10, 10, 30, 30], ...entry,
  })));
  const bytes = await original.save(), book = await PDFDocument.create(); book.addPage();
  await appendPages(book, bytes);
  const combined = await PDFDocument.create(); combined.addPage();
  await appendPages(combined, await book.save());
  const reopened = await PDFDocument.load(await combined.save());
  const annotations = reopened.getPage(2).node.lookup(PDFName.of("Annots"), PDFArray);
  expect(annotations.size()).toBe(6);
  for (let index = 0; index < 4; index++) {
    const annotation = annotations.lookup(index, PDFDict);
    const action = annotation.lookup(PDFName.of("A"));
    const dest = annotation.lookupMaybe(PDFName.of("Dest"), PDFArray) ??
      (action as PDFDict).lookup(PDFName.of("D"), PDFArray);
    expect(String(dest.get(0))).toBe(String(reopened.getPage(3).ref));
    expect(dest.lookup(3, PDFNumber).asNumber()).toBe(400);
  }
  const remote = annotations.lookup(4, PDFDict).lookup(PDFName.of("A"), PDFDict);
  expect(remote.lookup(PDFName.of("D"), pdf.PDFString).decodeText()).toBe("section");
  expect(annotations.lookup(5, PDFDict).lookup(PDFName.of("A"), PDFDict)
    .lookup(PDFName.of("URI"), pdf.PDFString).decodeText()).toBe("https://example.test");
  const retained = await PDFDocument.load(bytes);
  expect(retained.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).lookup(1, PDFDict)
    .lookup(PDFName.of("Dest"), pdf.PDFString).decodeText()).toBe("section");
});

it("omits internal links to pages excluded from an extracted PDF", async () => {
  const original = await PDFDocument.create(); original.addPage(); original.addPage();
  addInternalLink(original.getPage(0), [10, 10, 30, 30], original.getPage(1));
  const extracted = await PDFDocument.create();
  await appendPages(extracted, original, [0]);
  const reopened = await PDFDocument.load(await extracted.save());
  expect(reopened.getPageCount()).toBe(1);
  expect(reopened.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(0);
});

it("does not return an output when cancelled during assembly", async () => {
  const controller = new AbortController();
  await expect(assemble({ fonts: { regular: StandardFonts.TimesRoman }, parts: [],
    signal: controller.signal, before: ({ document }) => {
      document.addPage(); controller.abort();
    } })).rejects.toHaveProperty("name", "AbortError");
});

it("keeps numbers inside rotated crop boxes and preserves navigation and hidden text on save", async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.TimesRoman);
  for (const angle of [0, 90, 180, 270]) {
    const page = document.addPage([700, 900]);
    page.setCropBox(20, 30, 600, 800);
    page.setRotation(degrees(angle));
    drawPageNumber(page, 17, font, "bottom-right", 12, 100, 50);
    applyOcrText(page, font, "Recognized passage");
  }
  addInternalLink(document.getPage(0), [40, 40, 100, 60], document.getPage(3));
  applyOutlines(document, [{ title: "Sources", pageIndex: 0, children: [
    { title: "Rotated source", pageIndex: 3 },
  ] }], true);
  applyPageLabels(document, 17);
  const saved = await PDFDocument.load(await document.save());
  const expected = [[508, 80], [570, 718], [132, 780], [70, 142]];
  saved.getPages().forEach((page, index) => {
    const streams = page.node.Contents() as PDFArray;
    const content = streams.asArray().map((ref) => Buffer.from(decodePDFRawStream(
      saved.context.lookup(ref, PDFRawStream)).decode()).toString("latin1")).join("\n");
    const matrix = content.match(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/u)!;
    expect(matrix.slice(5).map(Number)).toEqual(expected[index]);
    expect(content).toContain(Buffer.from("Recognized passage").toString("hex").toUpperCase());
  });
  const labels = saved.catalog.lookup(PDFName.of("PageLabels"), PDFDict)
    .lookup(PDFName.of("Nums"), PDFArray);
  expect(labels.lookup(1, PDFDict).lookup(PDFName.of("St"), PDFNumber).asNumber()).toBe(17);
  const first = saved.catalog.lookup(PDFName.of("Outlines"), PDFDict)
    .lookup(PDFName.of("First"), PDFDict);
  const child = first.lookup(PDFName.of("First"), PDFDict);
  expect(child.lookup(PDFName.of("Title"), PDFHexString).decodeText()).toBe("Rotated source");
  expect(String(child.lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(saved.getPage(3).ref));
  const link = saved.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).lookup(0, PDFDict);
  expect(String(link.lookup(PDFName.of("Dest"), PDFArray).get(0))).toBe(String(saved.getPage(3).ref));
});
