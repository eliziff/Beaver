import { Document, ImageRun, Packer, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import {
  DOCX_DRAFTING_SOURCE_FORMAT,
  MAX_DRAFTING_DOCX_BYTES,
  MAX_DRAFTING_XML_ENTRY_BYTES,
  extractDocxDraftingSource,
} from "../docxDraftingSource";
import { renderDocxMarkdown } from "../chat/tools/docxMarkdown";

describe("DOCX drafting source", () => {
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

    const source = await extractDocxDraftingSource(bytes);

    expect(source.format).toBe(DOCX_DRAFTING_SOURCE_FORMAT);
    expect(source.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(source.html).toContain("<h1><strong>Agreement</strong></h1>");
    expect(source.html).toContain("<strong>Vendor</strong>");
    expect(source.html).toContain("<ul>");
    expect(source.html).toContain("<table>");
    expect(source.html).toContain('href="#footnote-');
    expect(source.html).toContain("This is the source footnote.");
    expect(source.requires_review).toBe(false);
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

    const source = await extractDocxDraftingSource(bytes);

    expect(source.html).toContain("[Image omitted]");
    expect(source.html).not.toMatch(/data:/iu);
    expect(source.html).not.toContain(png.toString("base64"));
    expect(source.warnings.join(" ")).toContain("embedded image");
    expect(source.requires_review).toBe(true);
  });

  it("fails closed for non-DOCX, oversized, and highly compressed inputs", async () => {
    await expect(
      extractDocxDraftingSource(Buffer.from("not a docx")),
    ).rejects.toThrow();
    await expect(
      extractDocxDraftingSource(Buffer.alloc(MAX_DRAFTING_DOCX_BYTES + 1)),
    ).rejects.toThrow("exceeds");

    const zip = new (await import("jszip")).default();
    zip.file(
      "word/document.xml",
      "x".repeat(MAX_DRAFTING_XML_ENTRY_BYTES + 1),
    );
    const compressed = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    expect(compressed.length).toBeLessThan(MAX_DRAFTING_DOCX_BYTES);
    await expect(extractDocxDraftingSource(compressed)).rejects.toThrow(
      "oversized XML",
    );
  });
});
