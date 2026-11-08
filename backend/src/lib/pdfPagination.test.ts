import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { structureNative } from "./structureNative";
import { reporterStartPages, resolvePrintedPages, type PdfPageBinding } from "./pdfPagination";

// A page map as the engine returns one: each page its label as printed.
const map = (labels: Array<string | null>): PdfPageBinding[] => labels.map((label, index) => ({ pdfPage: index + 1,
  observed: label, label, source: label ? "detected" : null, status: label ? "resolved" : "unknown" }));

describe("shared printed pagination", () => {
  it("reads the reports' first pages, and selects no duplicate or unbound page", () => {
    expect(reporterStartPages(["[1986] 1 SCR 103", "410 U.S. 113"])).toEqual([103,113]);
    const repeated = map(["5","6","5"]);
    expect(resolvePrintedPages("5",repeated)).toEqual([]);
    expect(resolvePrintedPages("5–6",repeated)).toEqual([]);
    expect(resolvePrintedPages("2",map([null,"2",null]))).toEqual([]);
    expect(resolvePrintedPages("150",map([null,null]))).toEqual([]);
  });

  it("resolves shortened page ranges only with complete unique bindings and rejects unsafe numbers", () => {
    const labels = map(["138", "139", "140"]);
    expect(resolvePrintedPages("138-39", labels)).toEqual([0, 1]);
    expect(resolvePrintedPages("138-40", labels)).toEqual([0, 1, 2]);
    expect(resolvePrintedPages("138-7", labels)).toEqual([]);
    expect(resolvePrintedPages("138-39", map(["138", "139", null]))).toEqual([]);
    expect(resolvePrintedPages("138-39", map(["138", "139", "139"]))).toEqual([]);
    expect(resolvePrintedPages("100000000000000000000", labels)).toEqual([]);
  });

  it("reads Roman, prefixed, and repeated embedded number-tree labels", async () => {
    const document = await PDFDocument.create();
    for(let i=0;i<5;i++) document.addPage();
    document.catalog.set(PDFName.of("PageLabels"),document.context.obj({Nums:[
      0,{S:"r",St:1},2,{S:"D",St:5,P:PDFString.of("A-")},4,{S:"D",St:5,P:PDFString.of("A-")},
    ]}));
    const prepared = await structureNative().derivePdfDocument(Buffer.from(await document.save()), {});
    expect(structureNative().pdfDocumentSummary(prepared).embeddedPageLabels).toEqual(["i","ii","A-5","A-6","A-5"]);
  });
});
