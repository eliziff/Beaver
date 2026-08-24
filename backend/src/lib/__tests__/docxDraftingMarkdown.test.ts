import { Document, ImageRun, Packer, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import { renderDocxMarkdown } from "../chat/tools/docxMarkdown";
import {
  MAX_DRAFTING_DOCX_BYTES,
  MAX_DRAFTING_XML_ENTRY_BYTES,
} from "../docx/core";
import { structureNative } from "../structureNative";

const draftingText = async (bytes: Buffer) => {
  const native = structureNative();
  return native.documentText(await native.deriveDocxDocument(bytes, "test", true));
};

describe("DOCX drafting Markdown", () => {
  it("preserves semantic structure and native footnote pairing", async () => {
    const bytes = await renderDocxMarkdown(
      [
        "# Agreement",
        "",
        "The **Vendor** supplies services.[^1]",
        "",
        "- First obligation",
        "- Second obligation",
        "",
        "| Term | Value |",
        "| --- | --- |",
        "| Price | $100 |",
        "",
        "[^1]: This is the source footnote.",
      ].join("\n"),
      { title: "Source precedent" },
    );

    const markdown = await draftingText(bytes);

    // Headings are preserved as # / ## markers (Pandoc resolves them
    // from the style definitions after our styles patch).
    expect(markdown).toMatch(/^# \*\*Agreement\*\*$/mu);
    // Bold text preserved
    expect(markdown).toContain("**Vendor**");
    // Lists preserved
    expect(markdown).toContain("- First obligation");
    // Tables preserved (Pandoc emits grid tables by default)
    expect(markdown).toContain("Price");
    // Footnotes round-trip as [^N] / [^N]: markers natively
    expect(markdown).toContain("[^1]");
    expect(markdown).toContain("[^1]: This is the source footnote.");
    // No HTML footnote-link noise
    expect(markdown).not.toContain('href="#footnote-');
  });

  it("omits image bytes and reports the omission", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new ImageRun({
                    data: png,
                    transformation: { width: 1, height: 1 },
                    type: "png",
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    );

    const markdown = await draftingText(bytes);

    expect(markdown).toContain("[Image omitted]");
    expect(markdown).not.toMatch(/data:/iu);
    expect(markdown).not.toContain(png.toString("base64"));
  });

  it("fails closed for invalid, oversized, and oversized-XML inputs", async () => {
    await expect(
      draftingText(Buffer.from("not a docx")),
    ).rejects.toThrow();
    await expect(
      draftingText(Buffer.alloc(MAX_DRAFTING_DOCX_BYTES + 1)),
    ).rejects.toThrow("exceeds");

    const zip = new (await import("jszip")).default();
    zip.file(
      "word/document.xml",
      "x".repeat(MAX_DRAFTING_XML_ENTRY_BYTES + 1),
    );
    const archive = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
    });
    expect(archive.length).toBeLessThan(MAX_DRAFTING_DOCX_BYTES);
    await expect(draftingText(archive)).rejects.toThrow(
      "oversized XML",
    );
  });
});
