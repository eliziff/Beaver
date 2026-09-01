import JSZip from "jszip";
import { Document, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import { describe, expect, it } from "vitest";
import { renderMarkdownDocx } from "../chat/tools/documentOps";
import {
  applyDocxBodyEdit,
  applyTableOfAuthorities,
  addNativeTableOfAuthorities,
  inspectDocxBody,
  previewDocxBodyEdit,
  type DocxVersionSource,
} from "../docxOperations";
import {
  extractDocxBodyText,
  extractTrackedChangeIds,
} from "../docxTrackedChanges";
import { sha256 } from "../hash";

async function fixture(markdown = "Section 1. Rent. Section 2. Rent.") {
  const rendered = await renderMarkdownDocx("Operation fixture", markdown);
  if ("error" in rendered) throw new Error(rendered.error);
  return rendered.bytes;
}

const source = (bytes: Buffer, versionId = "version-1"): DocxVersionSource => ({
  documentId: "document-1",
  versionId,
  sourceSha256: sha256(bytes),
});

describe("exact DOCX body operation receipt", () => {
  it("previews deterministically and applies one pinned duplicate as a tracked change", async () => {
    const bytes = await fixture();
    const inspection = await inspectDocxBody(bytes, source(bytes));
    const start = inspection.text.lastIndexOf("Rent");
    const input = {
      target: { part: inspection.part, start, end: start + 4 },
      replacement: "Base Rent",
    };
    const receipt = previewDocxBodyEdit(inspection, input);

    expect(previewDocxBodyEdit(inspection, input)).toEqual(receipt);
    expect(receipt.target).toMatchObject({
      part: "word/document.xml",
      coordinate: "accepted_body_text",
      start,
      end: start + 4,
      text: "Rent",
    });

    const result = await applyDocxBodyEdit(bytes, source(bytes), receipt);
    expect(result.status).toBe("applied");
    expect(result.changes).toHaveLength(1);
    await expect(extractDocxBodyText(result.bytes)).resolves.toContain(
      "Section 1. Rent. Section 2. Base Rent.",
    );
    await expect(extractTrackedChangeIds(result.bytes)).resolves.not.toEqual([]);

    const repeated = await applyDocxBodyEdit(
      result.bytes,
      source(result.bytes, "version-2"),
      receipt,
    );
    expect(repeated).toMatchObject({ status: "unchanged", changes: [] });
    expect(repeated.bytes).toBe(result.bytes);
  });

  it("rejects tampered receipts and stale versions instead of searching", async () => {
    const bytes = await fixture();
    const inspection = await inspectDocxBody(bytes, source(bytes));
    const start = inspection.text.lastIndexOf("Rent");
    const receipt = previewDocxBodyEdit(inspection, {
      target: { part: inspection.part, start, end: start + 4 },
      replacement: "Base Rent",
    });

    await expect(applyDocxBodyEdit(bytes, source(bytes), {
      ...receipt,
      operation: { ...receipt.operation, replacement: "Term" },
    })).rejects.toMatchObject({ code: "invalid_receipt" });
    await expect(applyDocxBodyEdit(
      bytes,
      source(bytes),
      null as unknown as typeof receipt,
    )).rejects.toMatchObject({ code: "invalid_receipt" });
    await expect(applyDocxBodyEdit(
      bytes,
      source(bytes, "version-2"),
      receipt,
    )).rejects.toMatchObject({ code: "stale_source" });

    const changed = await fixture("Section 1. Fee. Section 2. Rent.");
    await expect(applyDocxBodyEdit(
      changed,
      source(changed),
      receipt,
    )).rejects.toMatchObject({ code: "stale_source" });
  });

  it("keeps the first slice to exact, tracked, single-paragraph replacements", async () => {
    const bytes = await fixture("First paragraph.\n\nSecond paragraph.");
    const inspection = await inspectDocxBody(bytes, source(bytes));
    expect(() => previewDocxBodyEdit(inspection, {
      target: { part: inspection.part, start: 0, end: inspection.text.length },
      replacement: "Combined",
    })).toThrowError(/cannot cross a paragraph boundary/u);
    expect(() => previewDocxBodyEdit(inspection, {
      target: { part: inspection.part, start: 0, end: 5 },
      replacement: "FIRST",
      tracked: false,
    })).toThrowError(/tracked changes are required/u);
  });
});

describe("native Word Table of Authorities output", () => {
  it("supports mark-only and static linked append without conflating their structures",
    async () => {
    const body = "R v Grant, 2009 SCC 32";
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph({ children: [new TextRun(body)] }),
    ] }] }));
    const mark = { unitId: "body:0", offset: body.length, longName: body,
      shortName: "R v Grant", category: 1 as const };
    const marked = await applyTableOfAuthorities(bytes, [{ id: "body:0", text: body }],
      [mark], "native-marks");
    const markedXml = await (await JSZip.loadAsync(marked))
      .file("word/document.xml")!.async("string");
    expect(markedXml).toContain(" TA \\l");
    expect(markedXml).not.toContain(" TOA \\h");
    expect(markedXml).not.toContain("Table of Authorities");

    const linked = await applyTableOfAuthorities(bytes, [{ id: "body:0", text: body }],
      [mark], "linked-append", [
        { label: body, url: "https://decisions.example.test/grant?a=1&b=2" },
        { label: "Unlinked authority", url: null },
      ]);
    const linkedXml = await (await JSZip.loadAsync(linked))
      .file("word/document.xml")!.async("string");
    expect(linkedXml).not.toContain(" TA \\l");
    expect(linkedXml).toContain("TABLE OF AUTHORITIES");
    expect(linkedXml).toContain("R v Grant, 2009 SCC 32");
    expect(linkedXml).toContain("HYPERLINK &quot;https://decisions.example.test/grant?a=1&amp;b=2&quot;");
    expect(linkedXml).toContain("Unlinked authority");
    expect(linkedXml).not.toContain("copy required");
    expect(linkedXml.indexOf("TABLE OF AUTHORITIES")).toBeLessThan(
      linkedXml.indexOf("w:sectPr"));
  });

  it("marks body and footnote citations and appends one updateable TOA before sectPr", async () => {
    const body = "R v Grant, 2009 SCC 32";
    const footnote = "Federal Courts Act, RSC 1985, c F-7";
    const bytes = await Packer.toBuffer(new Document({
      footnotes: { 7: { children: [new Paragraph({ children: [new TextRun(footnote)] })] } },
      sections: [{ children: [new Paragraph({ children: [
        new TextRun(body), new FootnoteReferenceRun(7),
      ] })] }],
    }));
    const result = await addNativeTableOfAuthorities(bytes, [
      { id: "body:0", text: body }, { id: "footnote:7", text: footnote },
    ], [
      { unitId: "body:0", offset: body.length, longName: body,
        shortName: "R v Grant", category: 1 },
      { unitId: "footnote:7", offset: footnote.length, longName: footnote,
        shortName: "Federal Courts Act", category: 2 },
    ]);

    const zip = await JSZip.loadAsync(result);
    const document = await zip.file("word/document.xml")!.async("string");
    const notes = await zip.file("word/footnotes.xml")!.async("string");
    const settings = await zip.file("word/settings.xml")!.async("string");
    expect(document).toContain(' TA \\l &quot;R v Grant, 2009 SCC 32&quot; \\s &quot;R v Grant&quot; \\c 1 ');
    expect(notes).toContain(' TA \\l &quot;Federal Courts Act, RSC 1985, c F-7&quot;');
    expect(document).toContain(' TOA \\h \\e &quot;\\t&quot; ');
    expect(document).toContain("w:vanish");
    expect(document.indexOf("Table of Authorities")).toBeLessThan(document.indexOf("w:sectPr"));
    expect(settings).toMatch(/w:updateFields[^>]+w:val="true"/u);
    expect(await zip.file("[Content_Types].xml")!.async("string"))
      .toContain("wordprocessingml.document.main+xml");
  });
});
