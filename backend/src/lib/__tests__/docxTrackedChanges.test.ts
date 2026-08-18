import { describe, expect, it } from "vitest";

import {
  applyTrackedEdits,
  extractDocxBodyText,
  extractTrackedChangeIds,
  finalizeTrackedEdits,
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
    expect(
      edit.changes[0].diff
        .filter(({ kind }) => kind !== "insert")
        .map(({ text }) => text)
        .join(""),
    ).toBe("at paras 332-334 and the answer in R v Smith");
    expect(
      edit.changes[0].diff
        .filter(({ kind }) => kind !== "delete")
        .map(({ text }) => text)
        .join(""),
    ).toBe("at paras 332-34 and the answer in R v Smyth");
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

  it("makes Auto output equal to accepting the Manual edit plan", async () => {
    const bytes = await draft("The initial term is five years.");
    const edit = await applyTrackedEdits(bytes, [{
      find: "initial term is five years",
      replace: "renewal term is three years",
      context_before: "The ",
      context_after: ".",
    }]);
    const ids = edit.changes.flatMap((change) =>
      [change.delId, change.insId].filter((id): id is string => !!id),
    );

    const manual = await finalizeTrackedEdits(edit.bytes, ids, "manual");
    const automatic = await finalizeTrackedEdits(edit.bytes, ids, "auto");
    const accepted = await resolveTrackedChange(manual.bytes, ids, "accept");
    const incomplete = await resolveTrackedChange(
      manual.bytes,
      [...ids, "missing-revision"],
      "accept",
    );

    expect(manual.status).toBe("pending");
    expect(await extractTrackedChangeIds(manual.bytes)).not.toHaveLength(0);
    expect(incomplete).toEqual({ bytes: manual.bytes, found: false });
    expect(automatic.status).toBe("accepted");
    expect(await extractTrackedChangeIds(automatic.bytes)).toHaveLength(0);
    expect(await extractDocxBodyText(automatic.bytes)).toBe(
      await extractDocxBodyText(accepted.bytes),
    );
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

describe("applyTrackedEdits anchor failures", () => {
  it("rejects an ambiguous anchor without changing the document", async () => {
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
    expect(reason).toContain("document is unchanged");
  });

  it("rejects a quote that is not on the document text plane", async () => {
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
    expect(reason).toContain("document is unchanged");
  });

  it("does not treat existing replacement text as an edit match", async () => {
    const bytes = await draft("Notice shall be given within thirty days.");
    const edit = await applyTrackedEdits(bytes, [
      { find: "within ten days", replace: "within thirty days" },
    ]);

    expect(edit.changes).toHaveLength(0);
    expect(edit.errors[0].reason).toContain("Could not locate");
  });

  it("rejects absent text", async () => {
    const bytes = await draft("The parties agree to arbitrate in Toronto.");
    const edit = await applyTrackedEdits(bytes, [
      { find: "governed by the laws of Alberta", replace: "governed by the laws of Ontario" },
    ]);

    expect(edit.changes).toHaveLength(0);
    expect(edit.errors[0].reason).toContain("Could not locate");
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
    expect(reason).toContain("Ambiguous match");
  });
});
