import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { assertSafeOfficeConversion } from "../convert";

const relationships = (value: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${value}</Relationships>`;

describe("Office conversion boundary", () => {
  it("allows inert hyperlinks but rejects fetchable relationships", async () => {
    const hyperlink = new JSZip();
    hyperlink.file("word/_rels/document.xml.rels", relationships(
      '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test" TargetMode="External"/>',
    ));
    await expect(assertSafeOfficeConversion(hyperlink)).resolves.toBeUndefined();

    const image = new JSZip();
    image.file("word/_rels/document.xml.rels", relationships(
      '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1/private" TargetMode="External"/>',
    ));
    await expect(assertSafeOfficeConversion(image)).rejects.toThrow(
      "active external relationship",
    );

    const localLink = new JSZip();
    localLink.file("word/_rels/document.xml.rels", relationships(
      '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///etc/passwd" TargetMode="External"/>',
    ));
    await expect(assertSafeOfficeConversion(localLink)).rejects.toThrow(
      "active external relationship",
    );
  });

  it("rejects embedded objects and linked-content fields", async () => {
    const embedded = new JSZip();
    embedded.file("word/embeddings/object.bin", "object");
    await expect(assertSafeOfficeConversion(embedded)).rejects.toThrow("embedded object");

    const linked = new JSZip();
    linked.file("word/document.xml",
      '<w:document><w:instrText> INCLUDETEXT "file:///etc/passwd" </w:instrText></w:document>');
    await expect(assertSafeOfficeConversion(linked)).rejects.toThrow("active linked content");

    const macro = new JSZip();
    macro.file("xl/vbaProject.bin", "macro");
    await expect(assertSafeOfficeConversion(macro)).rejects.toThrow("embedded object");
  });

  it("parses encoded relationship attributes before applying policy", async () => {
    const encoded = new JSZip();
    encoded.file("word/_rels/document.xml.rels", relationships(
      '<Relationship Id="r1" Type="urn:office:image" Target="file:///etc/passwd" TargetMode="Exter&#x6e;al"/>',
    ));
    await expect(assertSafeOfficeConversion(encoded)).rejects.toThrow(
      "active external relationship",
    );
  });
});
