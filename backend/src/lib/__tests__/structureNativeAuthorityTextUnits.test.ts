import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pdfPassageGeometry, structureNative } from "../structureNative";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function sourceDocx() {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="${W}"><w:body><w:p><w:r>` +
    `<w:t>A😀</w:t><w:footnoteReference w:id="7"/><w:t>B</w:t>` +
    `</w:r></w:p></w:body></w:document>`);
  zip.file("word/footnotes.xml", `<w:footnotes xmlns:w="${W}">` +
    `<w:footnote w:id="7"><w:p><w:r><w:t>Note.</w:t></w:r></w:p></w:footnote>` +
    `</w:footnotes>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function sourcePdf(text: string | string[] = "Body exact quote appears here") {
  const lines = Array.isArray(text) ? text : [text];
  const stream = `BT /F1 12 Tf 72 720 Td ${lines
    .map((line, index) => `(${line}) Tj${index + 1 < lines.length ? " 0 -14 Td" : ""}`)
    .join(" ")} ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(pdf);
    pdf += object;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("")}` +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("native authority text units", () => {
  it("returns ordered DOCX units and keeps the PDF handle boundary explicit", async () => {
    const native = structureNative();
    const bytes = await sourceDocx();
    expect(await native.docxAuthorityTextUnits(bytes)).toEqual([
      { key: "body:0", kind: "body", ordinal: 0, footnote_id: null,
        page_numbers: [], text: "A😀B", footnote_refs: [[1, 3]] },
      { key: "footnote:7", kind: "footnote", ordinal: 1, footnote_id: 1,
        page_numbers: [], text: "Note.", footnote_refs: [] },
    ]);

    const docx = await native.deriveDocxDocument(bytes, "docx");
    expect(() => native.pdfAuthorityTextUnits(docx))
      .toThrow("PDF authority text units require a PDF document");

    const pdf = await native.derivePdfDocument(sourcePdf(), {});
    const pdfUnits = native.pdfAuthorityTextUnits(pdf);
    expect(pdfUnits.map(({ text }) => text).join("\n")).toContain("Body");
    expect(pdfUnits.find(({ text }) => text.includes("Body"))?.page_numbers).toEqual([1]);

    const geometry = await pdfPassageGeometry(pdf, sourcePdf(), [{
      id: "p1", locatorKind: "paragraph", locator: "1",
      exactQuotes: ["exact quote appears here"],
    }]);
    expect(geometry).toMatchObject({
      schemaVersion: "legalpdf.passage-geometry.v1",
      sourceSha256: native.pdfDocumentSummary(pdf).sha256,
      coordinateOrigin: "top_left",
      rotationApplied: true,
      targets: [{
        id: "p1", locatorKind: "paragraph", locator: "1", status: "found",
        pages: [{ pageNumber: 1, width: 612, height: 792, source: "native" }],
        quotes: [{ text: "exact quote appears here", status: "found", pageNumber: 1 }],
      }],
    });
    expect(geometry.targets[0].pages[0].passageRects).toHaveLength(1);
    expect(geometry.targets[0].quotes[0].rects.length).toBeGreaterThan(0);

    const numberedBytes = sourcePdf("[29] The governing framework is stated here.");
    const numberedPdf = await native.derivePdfDocument(numberedBytes, {});
    expect(await pdfPassageGeometry(numberedPdf, numberedBytes, [{
      id: "p29", locatorKind: "paragraph", locator: "29",
    }])).toMatchObject({ targets: [{ id: "p29", status: "found",
      pages: [{ pageNumber: 1, source: "native", passageRects: [expect.any(Array)] }] }] });

    const shiftedBytes = sourcePdf(["[29] Exact numbered paragraph",
      ...Array.from({ length: 29 }, (_, index) => `Structural paragraph ${index + 1}`)]);
    const shiftedPdf = await native.derivePdfDocument(shiftedBytes, {});
    expect(await pdfPassageGeometry(shiftedPdf, shiftedBytes, [{
      id: "shifted", locatorKind: "paragraph", locator: "29",
      exactQuotes: ["Exact numbered paragraph"],
    }])).toMatchObject({ targets: [{ id: "shifted", status: "found",
      quotes: [{ status: "found" }] }] });

    const changed = Buffer.from(sourcePdf().toString().replace("Body", "Bady"));
    await expect(pdfPassageGeometry(pdf, changed, [{
      id: "p1", locatorKind: "paragraph", locator: "1",
    }])).rejects.toThrow("source changed");

    const weakBytes = sourcePdf("x");
    const weakPdf = await native.derivePdfDocument(weakBytes, {});
    expect(native.pdfDocumentSummary(weakPdf).pagesNeedingOcr).toEqual([0]);
    expect(await pdfPassageGeometry(weakPdf, weakBytes, [{
      id: "page1", locatorKind: "page", locator: "1",
    }])).toMatchObject({ targets: [{
      id: "page1", locatorKind: "page", locator: "1", status: "unavailable",
      pages: [{ pageNumber: 1, width: 612, height: 792, source: "unavailable" }],
    }] });
  });
});

it("uses the complete printed paragraph, not just its numbered first line", async () => {
  const bytes = sourcePdf(["[29] This paragraph starts on the first line.",
    "The exact evidence continues on the second line.", "[30] A different paragraph follows."]);
  const native = structureNative(), document = await native.derivePdfDocument(bytes, {});
  const { targets: [target] } = await pdfPassageGeometry(document, bytes, [{ id: "29",
    locatorKind: "paragraph", locator: "29", exactQuotes: ["exact evidence continues", "A different paragraph follows"] }]);
  expect(target.status).toBe("found");
  expect(target.quotes.map(quote => quote.status)).toEqual(["found", "not_found"]);
  const [rect] = target.pages[0].passageRects;
  expect(rect[3] - rect[1]).toBeGreaterThan(20);
});

it("does not invent a paragraph when printed numbering is missing or duplicated", async () => {
  for (const [lines, status] of [
    [["[28] First paragraph with enough text.", "[30] The next paragraph with enough text."], "not_found"],
    [["[29] First paragraph with enough text.", "[30] Intervening paragraph with enough text.", "[29] Repeated label with enough text."], "ambiguous"],
  ] as const) {
    const bytes = sourcePdf([...lines]), document = await structureNative().derivePdfDocument(bytes, {});
    const result = await pdfPassageGeometry(document, bytes, [{ id: "29", locatorKind: "paragraph", locator: "29" }]);
    expect(result.targets[0].status).toBe(status);
    expect(result.targets[0].pages.flatMap(page => page.passageRects)).toEqual([]);
  }
});
