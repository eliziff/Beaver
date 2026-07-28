import { describe, expect, it } from "vitest";

import { applyTrackedEdits, extractDocxBodyText } from "../docxTrackedChanges";
import { renderMarkdownDocx } from "../chat/tools/documentOps";

async function draft(markdown: string): Promise<Buffer> {
  const rendered = await renderMarkdownDocx("Memo", markdown, []);
  if ("error" in rendered) throw new Error(rendered.error);
  return rendered.bytes;
}

describe("applyTrackedEdits minimal clusters", () => {
  it("tracks only the characters that changed, one change per spot", async () => {
    const bytes = await draft(
      "The authority appears at paras 332-334 and the answer in R v Smith.",
    );
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "at paras 332-334 and the answer in R v Smith",
        replace: "at paras 332-34 and the answer in R v Smyth",
        context_before: "appears ",
        context_after: ".",
      },
    ]);

    expect(edit.errors).toEqual([]);
    expect(
      edit.changes.map((c) => ({ del: c.deletedText, ins: c.insertedText })),
    ).toEqual([
      { del: "3", ins: "" },
      { del: "i", ins: "y" },
    ]);
    // The untouched middle stays out of the tracked ranges entirely.
    await expect(extractDocxBodyText(edit.bytes)).resolves.toContain(
      "at paras 332-34 and the answer in R v Smyth",
    );
  });

  it("keeps a word replacement as one whole-word change", async () => {
    const bytes = await draft("Accordingly, the plaintiff shall pay costs.");
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "the plaintiff shall pay",
        replace: "the defendant shall pay",
        context_before: "Accordingly, ",
        context_after: " costs",
      },
    ]);

    expect(edit.errors).toEqual([]);
    expect(edit.changes).toHaveLength(1);
    expect(edit.changes[0].deletedText).toBe("plaintiff");
    expect(edit.changes[0].insertedText).toBe("defendant");
  });
});

describe("applyTrackedEdits annotate mode", () => {
  it("rejects rationale-free markup", async () => {
    const bytes = await draft("The seat of arbitration shall be Zurich.");
    await expect(
      applyTrackedEdits(
        bytes,
        [
          {
            find: "Zurich",
            replace: "New York",
            context_before: "shall be ",
            context_after: ".",
          },
        ],
        { annotate: true },
      ),
    ).rejects.toThrow(/reason/u);
  });

  it("anchors one comment per edit spanning its revision", async () => {
    const bytes = await draft(
      "The seat of arbitration shall be Zurich. The panel shall be one arbitrator.",
    );
    const edit = await applyTrackedEdits(
      bytes,
      [
        {
          find: "Zurich",
          replace: "New York",
          context_before: "shall be ",
          context_after: ". The panel",
          reason: "LLC Agreement s. 12.2 requires a New York seat.",
        },
        {
          find: "one arbitrator",
          replace: "three arbitrators",
          context_before: "panel shall be ",
          context_after: ".",
          reason: "Three-arbitrator panel required by s. 12.2.",
        },
      ],
      { annotate: true },
    );
    expect(edit.errors).toEqual([]);
    expect(edit.comments).toBe(2);

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(edit.bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const commentsXml = await zip.file("word/comments.xml")!.async("string");
    const contentTypes = await zip
      .file("[Content_Types].xml")!
      .async("string");
    const rels = await zip
      .file("word/_rels/document.xml.rels")!
      .async("string");

    expect(documentXml.match(/<w:commentRangeStart /gu)).toHaveLength(2);
    expect(documentXml.match(/<w:commentRangeEnd /gu)).toHaveLength(2);
    expect(documentXml.match(/<w:commentReference /gu)).toHaveLength(2);
    expect(commentsXml).toContain(
      "LLC Agreement s. 12.2 requires a New York seat.",
    );
    expect(commentsXml.match(/<w:comment /gu)).toHaveLength(2);
    expect(contentTypes).toContain('PartName="/word/comments.xml"');
    expect(rels).toContain("relationships/comments");
    await expect(extractDocxBodyText(edit.bytes)).resolves.toContain(
      "New York",
    );
  });

  it("creates no comments part when annotate is off", async () => {
    const bytes = await draft("Pay within ten days.");
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "ten",
        replace: "thirty",
        context_before: "within ",
        context_after: " days",
        reason: "Longer cure period.",
      },
    ]);
    expect(edit.comments).toBe(0);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(edit.bytes);
    // The generator may ship an empty comments part; it must stay empty.
    const commentsFile = zip.file("word/comments.xml");
    if (commentsFile) {
      expect(await commentsFile.async("string")).not.toMatch(/<w:comment /u);
    }
  });
});
