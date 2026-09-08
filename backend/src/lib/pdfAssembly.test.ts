import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName,
  PDFNumber, PDFRawStream, StandardFonts, degrees } from "pdf-lib";
import { expect, it } from "vitest";
import * as pdf from "pdf-lib";
import { pdfAssembly } from "./pdfAssembly";
const { addInternalLink, applyOcrText, applyOutlines, applyPageLabels, drawPageNumber, assemble } = pdfAssembly(pdf);

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
