import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { pdfPassageGeometry, structureNative } from "../structureNative";
import { renderAuthoritySourcePdf } from "../authoritiesBuild";

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
      { key: "footnote:7", kind: "footnote", ordinal: 1, footnote_id: 1, note_number: 1, restart_sequence: 0,
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

it("locates a numeric pinpoint within a unique citation and abstains on repeated citation context", async () => {
  const citation = "2024 SCC 1 at para 29";
  for (const [lines, status] of [
    [[citation, "A different number 29 appears below."], "found"],
    [[citation, citation], "ambiguous"],
  ] as const) {
    const bytes = sourcePdf([...lines]), document = await structureNative().derivePdfDocument(bytes, {});
    const result = await pdfPassageGeometry(document, bytes, [{ id: "pinpoint", locatorKind: "page",
      locator: "1", physicalPages: [1], quoteSelections: [{ text: citation, start: 19, end: 21 }] }]);
    expect(result.targets[0].quotes[0]).toMatchObject({ text: "29", status });
    if (status === "found") {
      const [rect] = result.targets[0].quotes[0].rects;
      expect(rect[2] - rect[0]).toBeLessThan(20);
      expect(rect[1]).toBeLessThan(85);
    }
  }
});

it("distinguishes printed paragraph labels from an inferred paragraph number", async () => {
  for (const [text, printed] of [["[29] A printed numbered paragraph.", true],
    ["Unnumbered source text has no printed paragraph label.", false]] as const) {
    const bytes = sourcePdf(text), document = await structureNative().derivePdfDocument(bytes, {});
    const result = await pdfPassageGeometry(document, bytes, [{ id: "paragraph", locatorKind: "paragraph",
      locator: printed ? "29" : "1" }]);
    expect(result.targets[0].printed).toBe(printed);
  }
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

it("borders detached margin paragraphs across bilingual pages, excluding headers and the next heading", async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = () => {
    const result = pdf.addPage([612, 792]);
    result.drawText("Reporter header", { x: 72, y: 710, size: 10, font });
    result.drawText(String(pdf.getPageCount() + 14), { x: 520, y: 710, size: 10, font });
    return result;
  };
  const row = (p: ReturnType<typeof page>, y: number, text: string, label?: string) => {
    for (const x of [84, 318]) p.drawText(text, { x, y, size: 10, font });
    if (label) p.drawText(label, { x: 560, y: y + 2, size: 8, font });
  };
  const first = page();
  row(first, 600, "Prior numbered paragraph with enough text.", "20");
  row(first, 120, "The cited paragraph starts near the foot.", "21");
  row(first, 108, "Its first page has a second line of evidence.");
  const second = page();
  row(second, 670, "The cited paragraph continues on this page.");
  row(second, 658, "Its final line belongs inside the same border.");
  row(second, 620, "II. Legislation");
  row(second, 595, "The following paragraph is not cited here.", "22");
  row(second, 400, "Another numbered paragraph precedes it.", "23");
  row(second, 280, "The other cited paragraph starts here.", "24");
  row(second, 268, "All of this concluding line must be bordered.");
  row(second, 240, "IV. Issues");
  row(second, 215, "The next paragraph must remain outside.", "25");
  const bytes = Buffer.from(await pdf.save()), native = structureNative();
  const document = await native.derivePdfDocument(bytes, {});
  const { targets } = await pdfPassageGeometry(document, bytes,
    ["21", "24"].map(locator => ({ id: locator, locatorKind: "paragraph", locator })));
  expect(targets.map(target => target.status)).toEqual(["found", "found"]);
  expect(targets.map(target => target.pages.map(p => p.pageNumber))).toEqual([[1, 2], [2]]);
  const firstRect = targets[0].pages[0].passageRects[0];
  expect(firstRect[0]).toBe(84);
  expect(firstRect[1]).toBeLessThan(672); // Above the first drawn baseline.
  expect(firstRect[3]).toBeGreaterThan(684); // Below the second drawn baseline.
  expect(firstRect[3] - firstRect[1]).toBeLessThan(30);
  for (const target of targets) {
    expect(target.pages.map(p => p.text).join(" ")).not.toMatch(/Reporter|Legislation|Issues|following|next paragraph/);
    expect(target.pages.every(p => p.passageRects[0][2] > 450)).toBe(true);
  }
  expect(targets[0].pages[1].text).toContain("final line belongs inside");
  expect(targets[1].pages[0].text).toContain("concluding line must be bordered");
});

it.skipIf(!process.env.LEGAL_STRUCTURE_LATIMER_PDF)("resolves the original Latimer paragraphs 21 and 24 on their actual PDF pages", async () => {
  const bytes = readFileSync(process.env.LEGAL_STRUCTURE_LATIMER_PDF!);
  const native = structureNative(), document = await native.derivePdfDocument(bytes, {});
  expect(native.pdfDocumentSummary(document).sha256).toBe("c693092532727c6dcef049d90489414b5efd2dffb377d1a4a2ba08da572f7d01");
  const { targets } = await pdfPassageGeometry(document, bytes,
    ["21", "24"].map(locator => ({ id: locator, locatorKind: "paragraph", locator })));
  expect(targets.map(target => target.status)).toEqual(["found", "found"]);
  expect(targets.map(target => target.pages.map(p => p.pageNumber))).toEqual([[13, 14], [15]]);
  // Independent visual bounds: both columns, all continuation lines, no next heading.
  const bounds = [[84, 638, 534, 674], [60, 114, 510, 161], [84, 300, 534, 496]];
  targets.flatMap(target => target.pages).forEach((page, index) => {
    page.passageRects[0].forEach((coordinate, axis) =>
      expect(Math.abs(coordinate - bounds[index][axis])).toBeLessThan(2));
    expect(page.text).not.toMatch(/Legislation|Issues|questions en litige/);
  });
});

it("locates a rebuilt statute's sections and subsections, and reads its pages in one call", async () => {
  const provisions = Array.from({ length: 12 }, (_, index) => `**Rule ${index + 1}**\n\n**${index + 1}** (1) ` +
    `The harbour authority sets rule ${index + 1} for vessels at berth.\n\n(2) A master may ask for ` +
    `an exemption from rule ${index + 1} in writing.`).join("\n\n");
  const bytes = await renderAuthoritySourcePdf({ kind: "legislation", name: "Harbour Berths Act",
    citation: "SC 2031, c 7", date: null, sourceUrl: null, text: `## Berths\n\n${provisions}` });
  const native = structureNative(), document = await native.derivePdfDocument(bytes, {});
  const texts = native.pdfPageTexts(document);
  expect(texts).toHaveLength(native.pdfDocumentSummary(document).pageCount);
  expect(texts.join(" ")).toContain("The harbour authority sets rule 9 for vessels at berth.");
  const result = await pdfPassageGeometry(document, bytes, ["9", "9(2)", "40"].map((locator) =>
    ({ id: locator, locatorKind: "section" as const, locator })));
  const found = (id: string) => result.targets.find((target) => target.id === id)!;
  expect(found("9").status).toBe("found");
  expect(found("9(2)").status).toBe("found");
  expect(found("9(2)").pages.map((page) => page.text).join(" ")).toContain("exemption from rule 9");
  expect(found("9(2)").pages.map((page) => page.text).join(" ")).not.toContain("rule 10");
  expect(found("40").status).toBe("not_found");
});

it("reads a bilingual statute's sections from its English body, not its contents or French column", async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = (english: string, french: string) => {
    const result = pdf.addPage([612, 792]);
    result.drawText(english, { x: 48, y: 750, size: 7, font });
    result.drawText(french, { x: 318, y: 750, size: 7, font });
    return result;
  };
  const rows = (target: ReturnType<typeof page>, pairs: Array<[string, string]>) => pairs.forEach(([english, french], row) => {
    target.drawText(english, { x: 48, y: 700 - row * 14, size: 9, font });
    target.drawText(french, { x: 318, y: 700 - row * 14, size: 9, font });
  });
  const titles: Array<[string, string]> = [["Short title", "Titre abrégé"], ["Dues", "Droits"],
    ["Waiver of dues", "Dispense des droits"], ["Berths", "Postes"]];
  for (const half of [titles.slice(0, 2), titles.slice(2)]) {
    rows(page("TABLE OF PROVISIONS", "TABLE ANALYTIQUE"), half.map(([english, french]) => {
      const number = titles.findIndex(([title]) => title === english) + 1;
      return [`${number}  ${english}`, `${number}  ${french}`] as [string, string];
    }));
  }
  const english = (number: number) => [[titles[number - 1][0], titles[number - 1][1]],
    [`${number} (1)  The harbour master of the port sets the rule for`, `${number} (1)  Le capitaine du port fixe la règle pour`],
    ["the vessels that are at a berth in the port and the", "les navires qui sont à un poste dans le port et les"],
    ["owners of the cargo that is on the wharf.", "propriétaires de la cargaison qui est sur le quai."],
    [`(2)  A master of a vessel may ask for a waiver of rule ${number}.`, `(2)  Le capitaine d’un navire peut demander une dispense.`]] as Array<[string, string]>;
  for (const pair of [[1, 2], [3, 4]]) rows(page("Harbour Berths Act", "Loi sur les postes d’amarrage"), pair.flatMap(english));
  const bytes = Buffer.from(await pdf.save()), native = structureNative();
  const document = await native.derivePdfDocument(bytes, {});
  const result = await pdfPassageGeometry(document, bytes, ["2", "3(2)", "9"].map((locator) =>
    ({ id: locator, locatorKind: "section" as const, locator })));
  const found = (id: string) => result.targets.find((target) => target.id === id)!;
  expect(found("2").status).toBe("found");
  expect(found("2").pages.map((target) => target.pageNumber)).toEqual([3]);
  expect(found("2").pages[0].text).toContain("2 (1) The harbour master of the port sets the rule for");
  expect(found("2").pages[0].text).not.toMatch(/capitaine|Short title/);
  expect(found("3(2)").status).toBe("found");
  expect(found("3(2)").pages.map((target) => target.text).join(" ")).toContain("waiver of rule 3");
  expect(found("9").status).toBe("not_found");
});

it("reads a sentence a page break cuts before a provision reference as one paragraph", async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = (rows: string[]) => {
    const target = pdf.addPage([612, 792]);
    rows.forEach((row, index) => target.drawText(row, { x: 48, y: 720 - index * 11, size: 9, font }));
  };
  page(["Harbour Berths Act", "Decisions", "3  The harbour master of the port may make a decision",
    "(a)  that assigns a berth in the port to a vessel; or", "(b)  that sets the fee that is payable for the berth.",
    "Appeal", "4  A master of a vessel may appeal any decision of the", "harbour master of the port made under paragraph"]);
  page(["7(b) to the harbour authority within ten days of it.", "Fees", "5  The fee is payable on the arrival of the vessel."]);
  const bytes = Buffer.from(await pdf.save()), native = structureNative();
  const document = await native.derivePdfDocument(bytes, {});
  const result = await pdfPassageGeometry(document, bytes, ["4", "5", "7"].map((locator) =>
    ({ id: locator, locatorKind: "section" as const, locator })));
  const found = (id: string) => result.targets.find((target) => target.id === id)!;
  expect(found("4").status).toBe("found");
  expect(found("4").pages.map((target) => target.text).join(" ")).toContain("within ten days");
  expect(found("5").pages.map((target) => target.pageNumber)).toEqual([2]);
  expect(found("7").status).toBe("not_found");
});
