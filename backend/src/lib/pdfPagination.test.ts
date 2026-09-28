import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { structureNative } from "./structureNative";
import { reporterMarginLabels, reporterStartPages, resolvePdfPagination, resolvePrintedPages } from "./pdfPagination";

describe("shared printed pagination", () => {
  it("uses a reporter folio embedded in an opening margin, not a body citation or year", () => {
    const page = { pageNumber: 1, width: 504, height: 648, lines: [
      { text: "[1993] 4 R.C.S.", rect: [15,17,90,33], words: [] },
      { text: "R. C. BRASSARD Le juge L’Heureux-Dubé 287", rect: [160,17,472,33], words: [] },
      { text: "See [1993] 4 SCR 287", rect: [15,300,472,320], words: [] },
    ] };
    expect(reporterMarginLabels([null,null],[287],[page])).toEqual(["287",null]);
    expect(reporterMarginLabels([null],[1993],[page])).toEqual([null]);
    page.lines[1].text = "See [1993] 4 SCR 287";
    expect(reporterMarginLabels([null],[287],[page])).toEqual([null]);
  });
  it("locks the reporter start, preserves covers, and resolves pinpoints without OCR on later pages", () => {
    for (const [first, target, cover] of [[3,5,0],[145,150,0],[145,150,1]]) {
      const observed = Array<string | null>(10 + cover).fill(null); observed[cover] = String(first);
      const map = resolvePdfPagination(observed, [], [first]);
      expect(resolvePrintedPages(String(target), map))
        .toEqual([target - first + cover]);
      if (cover) expect(map[0].label).toBeNull();
      expect(map.at(-1)?.source).toBe("reporter");
    }
    expect(reporterStartPages(["[1986] 1 SCR 103", "410 U.S. 113"])).toEqual([103,113]);
  });

  it("does not invent a binding, overwrite conflicting evidence, or select duplicate pages", () => {
    expect(resolvePdfPagination([null,null],[],[145]).map(p=>p.label)).toEqual([null,null]);
    expect(resolvePdfPagination(["145",null,"149"],[],[145]).map(p=>p.label)).toEqual(["145",null,"149"]);
    expect(resolvePdfPagination(["145",null],["1","2"],[145]).map(p=>p.label)).toEqual(["145","146"]);
    expect(resolvePdfPagination(["145",null],["150","151"],[145])[0].status).toBe("ambiguous");
    const repeated = resolvePdfPagination(["5","6","5"], []);
    expect(resolvePrintedPages("5",repeated)).toEqual([]);
    expect(resolvePrintedPages("5–6",repeated)).toEqual([]);
    expect(resolvePrintedPages("2",resolvePdfPagination([null,"2",null], []))).toEqual([]);
    expect(resolvePrintedPages("150",resolvePdfPagination([null,null], []))).toEqual([]);
  });

  it("resolves shortened page ranges only with complete unique bindings and rejects unsafe numbers", () => {
    const labels = printedPageIndices(["138", "139", "140"]);
    expect(resolvePrintedPages("138-39", labels, 3)).toEqual([0, 1]);
    expect(resolvePrintedPages("138-40", labels, 3)).toEqual([0, 1, 2]);
    expect(resolvePrintedPages("138-7", labels, 3)).toEqual([]);
    expect(resolvePrintedPages("138-39", printedPageIndices(["138", "139", null]), 3)).toEqual([]);
    expect(resolvePrintedPages("138-39", printedPageIndices(["138", "139", "139"]), 3)).toEqual([]);
    expect(resolvePrintedPages("100000000000000000000", labels, 3)).toEqual([]);
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
