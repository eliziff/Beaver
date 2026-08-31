import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { structureNative } from "../structureNative";

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

function sourcePdf() {
  const stream = "BT /F1 12 Tf 72 720 Td (Body) Tj ET";
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
  });
});
