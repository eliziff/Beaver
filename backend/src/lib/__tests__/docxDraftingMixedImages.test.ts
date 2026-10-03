import { ImageRun, Paragraph } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { structureNative } from "../structureNative";
import { docxBytes } from "./support/docxFixtures";

async function mixedImageDocument(content: (drawing: string) => string) {
  const bytes = await docxBytes([
    new Paragraph({ children: [new ImageRun({ type: "png", transformation: { width: 1, height: 1 },
      data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") })] }),
    new Paragraph("Protected ending 42."),
  ]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  const drawing = xml.match(/<w:drawing\b[\s\S]*?<\/w:drawing>/u)![0];
  zip.file("word/document.xml", xml.replace(/<w:p\b[\s\S]*?<\/w:p>/u, content(drawing)));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function drafting(bytes: Buffer) {
  const original = Buffer.from(bytes);
  const native = structureNative();
  const text = native.documentText(await native.deriveDocxDocument(bytes, "mixed-image-test", true));
  expect(bytes).toEqual(original);
  expect(text).toContain("Protected ending 42.");
  return text;
}

describe("drafting reads text beside images in the same Word run", () => {
  it("retains text on both sides and its bold formatting", async () => {
    const text = await drafting(await mixedImageDocument(d =>
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Before seal </w:t>${d}<w:t xml:space="preserve"> after seal.</w:t></w:r></w:p>`));
    expect(text).toContain("**Before seal");
    expect(text).toContain("after seal.**");
    expect(text).toContain("[Image omitted]");
  });

  it("retains all fragments around two images in their original order", async () => {
    const text = await drafting(await mixedImageDocument(d =>
      `<w:p><w:r><w:t>First label </w:t>${d}<w:t> middle label </w:t>${d}<w:t> final label.</w:t></w:r></w:p>`));
    expect(text).toMatch(/First label.*\[Image omitted\].*middle label.*\[Image omitted\].*final label\./u);
    expect(text.match(/\[Image omitted\]/gu)).toHaveLength(2);
  });

  it("retains mixed-run text inside table cells", async () => {
    const text = await drafting(await mixedImageDocument(d =>
      `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Table label </w:t>${d}<w:t> remains legible.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`));
    expect(text).toContain("Table label");
    expect(text).toContain("remains legible.");
    expect(text).toContain("[Image omitted]");
  });

  it("retains text after an image that starts the run", async () => {
    const text = await drafting(await mixedImageDocument(d =>
      `<w:p><w:r>${d}<w:t>Leading image retains trailing text.</w:t></w:r></w:p>`));
    expect(text).toContain("[Image omitted]Leading image retains trailing text.");
  });
});
