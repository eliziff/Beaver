import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { structureNative } from "../structureNative";
import { renderAuthoritySourcePdf } from "../authoritiesBuild";
import { sha256 } from "../hash";
import { provenBlockLocator } from "../documentLocators";

/** A PDF read as the engine reads a stored source. */
const opened = async (bytes: Buffer) => (await structureNative().openSource(bytes, { documentId: "test",
  versionId: sha256(bytes), fileType: "pdf", sourceSha256: sha256(bytes), pdf: {} }))!;
const pdfPassageGeometry = structureNative().pdfPassageGeometry;

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


it("locates a numeric pinpoint within a unique citation and abstains on repeated citation context", async () => {
  const citation = "2024 SCC 1 at para 29";
  for (const [lines, status] of [
    [[citation, "A different number 29 appears below."], "found"],
    [[citation, citation], "ambiguous"],
  ] as const) {
    const bytes = sourcePdf([...lines]), document = await opened(bytes);
    const result = await pdfPassageGeometry(document, [{ id: "pinpoint", locatorKind: "page",
      locator: "1", physicalPages: [1], quoteSelections: [{ text: citation, start: 19, end: 21 }] }]);
    expect(result.targets[0].quotes[0]).toMatchObject({ text: "29", status });
    if (status === "found") {
      const [rect] = result.targets[0].quotes[0].rects;
      expect(rect[2] - rect[0]).toBeLessThan(20);
      expect(rect[1]).toBeLessThan(85);
    }
  }
});

it.each([
  { condition: "missing", lines: ["[28] First paragraph with enough text.", "[30] The next paragraph with enough text."], status: "not_found" },
  // Conflicting numbering establishes no primary paragraph count. Missing numbers in an established count are distinct.
  { condition: "duplicated", lines: ["[29] First paragraph with enough text.", "[30] Intervening paragraph with enough text.", "[29] Repeated label with enough text."], status: "unavailable" },
])("does not invent a paragraph when printed numbering is $condition", async ({ lines, status }) => {
    const bytes = sourcePdf(lines), document = await opened(bytes);
    const result = await pdfPassageGeometry(document, [{ id: "29", locatorKind: "paragraph", locator: "29" }]);
    expect(result.targets[0].status).toBe(status);
    expect(result.targets[0].pages.flatMap(page => page.passageRects)).toEqual([]);
});

it.skipIf(!process.env.LEGAL_STRUCTURE_LATIMER_PDF)("resolves the original Latimer paragraphs 21 and 24 on their actual PDF pages", async () => {
  const bytes = readFileSync(process.env.LEGAL_STRUCTURE_LATIMER_PDF!);
  const native = structureNative(), document = await opened(bytes);
  expect(native.pdfDocumentSummary(document).sha256).toBe("c693092532727c6dcef049d90489414b5efd2dffb377d1a4a2ba08da572f7d01");
  const { targets } = await pdfPassageGeometry(document,
    ["21", "24"].map(locator => ({ id: locator, locatorKind: "paragraph", locator })));
  expect(targets.map(target => target.status)).toEqual(["found", "found"]);
  expect(targets.map(target => target.pages.map(p => p.pageNumber))).toEqual([[13, 14], [15]]);
  // Independent visual bounds: both columns, all continuation lines, no next heading.
  const bounds = [[84, 638, 534, 674], [60, 114, 510, 161], [84, 300, 534, 496]];
  targets.flatMap(target => target.pages).forEach((page, index) => {
    // The engine returns each line's rectangle. The printed number beside the right column is separate
    // from the body bounds pinned above; it is part of the passage too.
    const body = page.passageRects.filter(([left]) => left < 540);
    const labels = page.passageRects.filter(([left]) => left >= 540);
    expect(labels).toHaveLength(index === 1 ? 0 : 1);
    for (const label of labels) {
      expect(label[0]).toBeCloseTo(549, 0);
      expect(label[2]).toBeCloseTo(558, 0);
      expect(Math.abs(label[1] - (index === 0 ? 636 : 297))).toBeLessThan(2);
    }
    const envelope = [Math.min(...body.map(rect => rect[0])), Math.min(...body.map(rect => rect[1])),
      Math.max(...body.map(rect => rect[2])), Math.max(...body.map(rect => rect[3]))];
    envelope.forEach((coordinate, axis) =>
      expect(Math.abs(coordinate - bounds[index][axis])).toBeLessThan(2));
    expect(page.text).not.toMatch(/Legislation|Issues|questions en litige/);
  });
});

it.skipIf(!process.env.LEGAL_STRUCTURE_BCE_PDF)("serves BCE's original footer notes through public document and evidence reads", async () => {
  const bytes = readFileSync(process.env.LEGAL_STRUCTURE_BCE_PDF!), native = structureNative();
  expect(sha256(bytes)).toBe("40941dbae64682c658781dd5ebb49e1dd4ea7c46306e0aa57f2abfcd52a52c85");
  const document = await opened(bytes);
  const notes = native.readDocumentRange(document, "footnote", "89", "90", 0);
  expect(notes?.selected).toHaveLength(2);
  for (const [index, note] of notes!.selected.entries()) {
    expect(note.node.kind).toBe("footnote");
    expect(note.node.page_indexes).toEqual([62]);
    expect(note.text).toContain(index ? "small localised cable networks" : "sources of all headline data");
    expect(provenBlockLocator(document, note, note.span)).toMatchObject({ kind: "footnote", label: String(89 + index) });
  }
});

it("locates a rebuilt statute's sections and subsections, and reads its pages in one call", async () => {
  const provisions = Array.from({ length: 12 }, (_, index) => `**Rule ${index + 1}**\n\n**${index + 1}** (1) ` +
    `The harbour authority sets rule ${index + 1} for vessels at berth.\n\n(2) A master may ask for ` +
    `an exemption from rule ${index + 1} in writing.`).join("\n\n");
  const { bytes } = await renderAuthoritySourcePdf({ kind: "legislation", name: "Harbour Berths Act",
    citation: "SC 2031, c 7", date: null, sourceUrl: null, text: `## Berths\n\n${provisions}` });
  const native = structureNative(), document = await opened(bytes);
  const texts = native.pdfPageTexts(document);
  expect(texts).toHaveLength(native.pdfDocumentSummary(document).pageCount);
  expect(texts.join(" ")).toContain("The harbour authority sets rule 9 for vessels at berth.");
  const result = await pdfPassageGeometry(document, ["9", "9(2)", "40"].map((locator) =>
    ({ id: locator, locatorKind: "section" as const, locator })));
  const found = (id: string) => result.targets.find((target) => target.id === id)!;
  expect(found("9").status).toBe("found");
  expect(found("9(2)").status).toBe("found");
  expect(found("9(2)").pages.map((page) => page.text).join(" ")).toContain("exemption from rule 9");
  expect(found("9(2)").pages.map((page) => page.text).join(" ")).not.toContain("rule 10");
  expect(found("40").status).toBe("not_found");
});
