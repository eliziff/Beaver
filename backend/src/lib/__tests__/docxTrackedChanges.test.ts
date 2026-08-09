import { describe, expect, it } from "vitest";

import {
  applyTrackedEdits,
  extractDocxBodyText,
  extractTrackedChangeIds,
  insertTrackedBlocks,
  resolveTrackedChange,
} from "../docxTrackedChanges";
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
    expect(edit.changes).toHaveLength(1);
    expect(edit.changes[0].deletedText).toContain("3");
    expect(edit.changes[0].deletedText).toContain("i");
    expect(edit.changes[0].insertedText).toBe("y");
    const revisionIds = await extractTrackedChangeIds(edit.bytes);
    expect(
      new Set(revisionIds.map((revision) => `${revision.kind}:${revision.w_id}`))
        .size,
    ).toBe(2);
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

  it("tracks one shape-preserving edit across adjacent paragraphs", async () => {
    const bytes = await draft("First old term.\n\nSecond old term.\n\nThird old term.");
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "First old term.\nSecond old term.\nThird old term.",
        replace: "First new term.\nSecond new term.\nThird new term.",
        context_before: "",
        context_after: "",
      },
    ]);

    expect(edit.errors).toEqual([]);
    expect(edit.changes.length).toBeGreaterThan(0);
    await expect(extractDocxBodyText(edit.bytes)).resolves.toContain(
      "First new term.\nSecond new term.\nThird new term.",
    );

    const ids = edit.changes.flatMap((change) =>
      [change.delId, change.insId].filter((id): id is string => Boolean(id)),
    );
    const accepted = await resolveTrackedChange(edit.bytes, ids, "accept");
    const rejected = await resolveTrackedChange(edit.bytes, ids, "reject");
    await expect(extractDocxBodyText(accepted.bytes)).resolves.toContain(
      "First new term.\nSecond new term.\nThird new term.",
    );
    await expect(extractDocxBodyText(rejected.bytes)).resolves.toContain(
      "First old term.\nSecond old term.\nThird old term.",
    );
  });
});

describe("insertTrackedBlocks", () => {
  it("inserts real paragraphs and rejects an inserted paragraph without residue", async () => {
    const bytes = await draft("Opening paragraph.");
    const inserted = await insertTrackedBlocks(bytes, {
      blocks: ["First inserted paragraph.", "Second inserted paragraph."],
      position: "after",
    });
    expect(inserted.errors).toEqual([]);
    expect(inserted.changes).toHaveLength(2);
    await expect(extractDocxBodyText(inserted.bytes)).resolves.toContain(
      "First inserted paragraph.\nSecond inserted paragraph.",
    );

    const rejected = await resolveTrackedChange(
      inserted.bytes,
      [inserted.changes[0].id],
      "reject",
    );
    const rejectedText = await extractDocxBodyText(rejected.bytes);
    expect(rejected.found).toBe(true);
    expect(rejectedText).not.toContain("First inserted paragraph.");
    expect(rejectedText).toContain("Second inserted paragraph.");
  });
});

describe("applyTrackedEdits trusted exact spans", () => {
  it("targets one pinned occurrence without re-resolving duplicate text", async () => {
    const bytes = await draft("Section 1. Rent. Section 2. Rent.");
    const text = await extractDocxBodyText(bytes);
    const start = text.lastIndexOf("Rent");
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "Rent",
        replace: "Base Rent",
        context_before: "",
        context_after: "",
        exact_start: start,
        exact_end: start + 4,
      },
    ]);

    expect(edit.errors).toEqual([]);
    await expect(extractDocxBodyText(edit.bytes)).resolves.toContain(
      "Section 1. Rent. Section 2. Base Rent.",
    );
  });

  it("refuses a stale exact span", async () => {
    const bytes = await draft("Section 1. Rent.");
    const text = await extractDocxBodyText(bytes);
    const start = text.indexOf("Rent");
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "Term",
        replace: "Base Term",
        context_before: "",
        context_after: "",
        exact_start: start,
        exact_end: start + 4,
      },
    ]);

    expect(edit.changes).toHaveLength(0);
    expect(edit.errors[0].reason).toContain("no longer matches");
  });

  it("preserves the unchanged prefix of an exact numbering edit", async () => {
    const bytes = await draft("1.03 Third provision.");
    const text = await extractDocxBodyText(bytes);
    const start = text.indexOf("1.03");
    const edit = await applyTrackedEdits(bytes, [
      {
        find: "1.03",
        replace: "1.02",
        context_before: "",
        context_after: "",
        exact_start: start,
        exact_end: start + 4,
      },
    ]);

    expect(edit.errors).toEqual([]);
    await expect(extractDocxBodyText(edit.bytes)).resolves.toContain(
      "1.02 Third provision.",
    );
  });
});

describe("applyTrackedEdits annotate mode", () => {
  it("annotates only reasoned edits; unreasoned ones apply without a comment", async () => {
    const bytes = await draft(
      "The seat of arbitration shall be Zurich. Costs follow the event.",
    );
    const edit = await applyTrackedEdits(
      bytes,
      [
        {
          find: "Zurich",
          replace: "New York",
          context_before: "shall be ",
          context_after: ". Costs",
          reason: "LLC Agreement s. 12.2 requires a New York seat.",
        },
        {
          find: "the event",
          replace: "the cause",
          context_before: "follow ",
          context_after: ".",
        },
      ],
      { annotate: true },
    );
    expect(edit.errors).toEqual([]);
    expect(edit.changes.length).toBeGreaterThanOrEqual(2);
    expect(edit.comments).toBe(1);
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

describe("applyTrackedEdits anchor diagnosis", () => {
  it("answers an ambiguous anchor with the real contexts that disambiguate", async () => {
    const bytes = await draft(
      [
        "The Tenant shall pay the Rent on the first day of each month.",
        "",
        "The Landlord may increase the Rent once in any twelve-month period.",
      ].join("\n"),
    );
    const edit = await applyTrackedEdits(bytes, [
      { find: "the Rent", replace: "the Base Rent" },
    ]);

    expect(edit.changes).toHaveLength(0);
    const reason = edit.errors[0].reason;
    expect(reason).toContain("Ambiguous match");
    expect(reason).toContain("2 occurrences");
    // The document's own words, ready to paste into the retry.
    expect(reason).toContain("The Tenant shall pay ");
    expect(reason).toContain(" on the first day of each month.");
    expect(reason).toContain("The Landlord may increase ");
  });

  it("shows the document's wording at the point the quote diverges", async () => {
    const bytes = await draft(
      "The Purchaser shall deliver the Closing Deliverables to the Vendor no later than 5:00 p.m. on the Closing Date.",
    );
    const edit = await applyTrackedEdits(bytes, [
      {
        // Verbatim up to "no later than", then paraphrased.
        find: "deliver the Closing Deliverables to the Vendor no later than 5:00 pm on the Closing Date",
        replace: "deliver the Closing Deliverables to the Vendor by noon on the Closing Date",
      },
    ]);

    expect(edit.changes).toHaveLength(0);
    const reason = edit.errors[0].reason;
    expect(reason).toContain("Could not locate");
    expect(reason).toMatch(/first \d+ characters do match/u);
    expect(reason).toContain("5:00 p.m. on the Closing Date");
  });

  it("recognises an edit whose replacement is already in the document", async () => {
    const bytes = await draft("Notice shall be given within thirty days.");
    const edit = await applyTrackedEdits(bytes, [
      { find: "within ten days", replace: "within thirty days" },
    ]);

    expect(edit.changes).toHaveLength(0);
    expect(edit.errors[0].reason).toContain("replacement text already is");
    expect(edit.errors[0].reason).toContain("applied already");
  });

  it("names the parts it cannot reach when nothing matches", async () => {
    const bytes = await draft("The parties agree to arbitrate in Toronto.");
    const edit = await applyTrackedEdits(bytes, [
      { find: "governed by the laws of Alberta", replace: "governed by the laws of Ontario" },
    ]);

    expect(edit.changes).toHaveLength(0);
    expect(edit.errors[0].reason).toContain("no part of this wording");
    expect(edit.errors[0].reason).toContain("header, footer, footnote");
  });

  it("diagnoses a pure insertion by its context anchor", async () => {
    const bytes = await draft(
      [
        "Each Party shall keep the Confidential Information confidential.",
        "",
        "Each Party shall bear its own costs.",
      ].join("\n"),
    );
    const edit = await applyTrackedEdits(bytes, [
      { find: "", replace: " at all times", context_before: "Each Party shall" },
    ]);

    expect(edit.changes).toHaveLength(0);
    const reason = edit.errors[0].reason;
    expect(reason).toContain("context_before");
    expect(reason).toContain("Ambiguous match");
  });
});
