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
