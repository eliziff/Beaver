import { ImageRun, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import { docxBytes } from "./support/docxFixtures";
import { renderDocxMarkdown } from "../chat/tools/docxMarkdown";
import { sha256 } from "../hash";
import { structureNative } from "../structureNative";

const draftingText = async (bytes: Buffer) => {
  const native = structureNative();
  return native.documentText((await native.openSource(bytes, { documentId: "test", versionId: "1", fileType: "docx", sourceSha256: sha256(bytes), mode: "drafting" }))!);
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
    const bytes = await docxBytes([
      new Paragraph({
        children: [
          new ImageRun({
            data: png,
            transformation: { width: 1, height: 1 },
            type: "png",
          }),
        ],
      }),
    ]);

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
      // A drafting-only limit may fall back to accepted text. This exceeds both views' package limit.
      draftingText(Buffer.alloc(50 * 1024 * 1024 + 1)),
    ).rejects.toThrow("exceeds");

    const zip = new (await import("jszip")).default();
    zip.file(
      "word/document.xml",
      "x".repeat(32 * 1024 * 1024 + 1),
    );
    const archive = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
    });
    expect(archive.length).toBeLessThan(50 * 1024 * 1024);
    await expect(draftingText(archive)).rejects.toThrow(
      /XML.*exceeds|oversized XML/u,
    );
  });
});
