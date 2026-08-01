import { describe, expect, it } from "vitest";
import { renderMarkdownDocx } from "../chat/tools/documentOps";
import {
  applyTextOpsToDocx,
  planTextOps,
  type TextOpRequest,
} from "../docxTextOps";
import {
  extractDocxBodyText,
  resolveTrackedChange,
} from "../docxTrackedChanges";

const MARKDOWN = [
  "The governing law clause controls this agreement.",
  "",
  "The parties agree the **governing law** of Ontario governs every dispute.",
  "",
  "Purchaser shall pay on closing. The purchaser may not assign. Each purchaser remains liable.",
  "",
  "The parties recieve notice and definately agree to the terms.",
].join("\n");

async function renderFixture() {
  const rendered = await renderMarkdownDocx("Text Ops Fixture", MARKDOWN);
  if ("error" in rendered) throw new Error(rendered.error);
  return rendered.bytes;
}

async function resolveAll(
  bytes: Buffer,
  edits: { delWId?: string; insWId?: string }[],
  mode: "accept" | "reject",
) {
  const ids = edits.flatMap((edit) =>
    [edit.delWId, edit.insWId].filter((id): id is string => !!id),
  );
  const resolved = await resolveTrackedChange(bytes, ids, mode);
  expect(resolved.found).toBe(true);
  return extractDocxBodyText(resolved.bytes);
}

describe("planTextOps scope resolution", () => {
  const docText = "Alpha beta gamma.\nDelta beta epsilon.\nZeta beta eta.";

  it("scopes find_text to every occurrence or the Nth", async () => {
    const all = await planTextOps(docText, [
      { op: "uppercase", scope: { kind: "find_text", text: "beta" } },
    ]);
    expect(all.replacements).toHaveLength(3);
    const second = await planTextOps(docText, [
      {
        op: "uppercase",
        scope: { kind: "find_text", text: "beta", occurrence: 2 },
      },
    ]);
    expect(second.replacements).toEqual([
      { start: 24, end: 28, text: "BETA" },
    ]);
  });

  it("scopes range from from_text through to_text", async () => {
    const { replacements } = await planTextOps(docText, [
      {
        op: "uppercase",
        scope: { kind: "range", from_text: "Delta", to_text: "Zeta" },
      },
    ]);
    // Scope covers "Delta beta epsilon.\nZeta"; the already-uppercase "D"/"Z"
    // stay outside the minimal changes, and one merged change per paragraph.
    expect(replacements).toHaveLength(2);
    expect(docText.slice(replacements[0].start, replacements[0].end)).toBe(
      "elta beta epsilon",
    );
    expect(replacements[0].text).toBe("ELTA BETA EPSILON");
    expect(docText.slice(replacements[1].start, replacements[1].end)).toBe(
      "eta",
    );
  });

  it("reports unfound scope text and bad occurrences", async () => {
    await expect(
      planTextOps(docText, [
        { op: "uppercase", scope: { kind: "find_text", text: "omega" } },
      ]),
    ).rejects.toThrow(/Scope text not found/);
    await expect(
      planTextOps(docText, [
        {
          op: "uppercase",
          scope: { kind: "find_text", text: "beta", occurrence: 7 },
        },
      ]),
    ).rejects.toThrow(/occurrence 7 not found \(3 matches\)/);
    await expect(
      planTextOps(docText, [
        {
          op: "uppercase",
          scope: { kind: "range", from_text: "Zeta", to_text: "Alpha" },
        },
      ]),
    ).rejects.toThrow(/Range end not found/);
  });

  it("matches scope text tolerantly across whitespace and smart quotes", async () => {
    const fancy = "The “governing  law” of the contract.";
    const { replacements } = await planTextOps(fancy, [
      {
        op: "uppercase",
        scope: { kind: "find_text", text: '"governing law"' },
      },
    ]);
    expect(replacements.length).toBeGreaterThan(0);
  });

  it("rejects overlapping changes from different ops", async () => {
    await expect(
      planTextOps(docText, [
        { op: "uppercase", scope: { kind: "find_text", text: "beta" } },
        { op: "toggle_case", scope: { kind: "find_text", text: "beta gamma" } },
      ]),
    ).rejects.toThrow(/overlapping/);
  });
});

describe("applyTextOpsToDocx end to end", () => {
  it("uppercases a find_text scope as exact tracked changes, including across bold runs", async () => {
    const bytes = await renderFixture();
    const originalText = await extractDocxBodyText(bytes);
    expect(originalText).toContain("governing law");

    const ops: TextOpRequest[] = [
      { op: "uppercase", scope: { kind: "find_text", text: "governing law" } },
    ];
    const applied = await applyTextOpsToDocx(bytes, ops);

    expect(applied.editErrors).toEqual([]);
    expect(applied.replacementCount).toBe(2);
    expect(applied.edits).toHaveLength(2);
    for (const edit of applied.edits) {
      expect(edit.deletedText).toBe("governing law");
      expect(edit.insertedText).toBe("GOVERNING LAW");
      expect(edit.delWId).toMatch(/^\d+$/);
      expect(edit.insWId).toMatch(/^\d+$/);
    }
    expect(applied.reports).toEqual([
      { op: "uppercase", replacements: 2, notes: [] },
    ]);

    // Accept-all yields exactly the transformed text; nothing else moved.
    const acceptedText = await resolveAll(applied.bytes, applied.edits, "accept");
    expect(acceptedText).toBe(
      originalText.replaceAll("governing law", "GOVERNING LAW"),
    );

    // Reject-all restores the original body text exactly.
    const rejectedText = await resolveAll(applied.bytes, applied.edits, "reject");
    expect(rejectedText).toBe(originalText);
  });

  it("runs Word-style replace_text over the whole document", async () => {
    const bytes = await renderFixture();
    const originalText = await extractDocxBodyText(bytes);
    const applied = await applyTextOpsToDocx(bytes, [
      {
        op: "replace_text",
        scope: { kind: "whole_document" },
        find: "purchaser",
        replace: "Buyer",
        whole_word: true,
      },
    ]);
    expect(applied.editErrors).toEqual([]);
    expect(applied.replacementCount).toBe(3);
    const acceptedText = await resolveAll(applied.bytes, applied.edits, "accept");
    expect(acceptedText).toBe(
      originalText
        .replaceAll("Purchaser", "Buyer")
        .replaceAll("purchaser", "Buyer"),
    );
  });

  it("check_spelling reports flags but never produces a tracked change", async () => {
    const bytes = await renderFixture();
    const applied = await applyTextOpsToDocx(bytes, [
      { op: "check_spelling", scope: { kind: "whole_document" } },
    ]);
    expect(applied.replacementCount).toBe(0);
    expect(applied.edits).toEqual([]);
    expect(applied.editErrors).toEqual([]);
    expect(applied.bytes).toBe(bytes);
    expect(applied.reports).toHaveLength(1);
    expect(applied.reports[0].notes).toMatchObject([
      { site: "recieve", reason: "possible misspelling" },
      { site: "definately", reason: "possible misspelling", suggestions: ["definitely"] },
    ]);
    expect(applied.reports[0].notes[0].suggestions).toContain("receive");

    // The explicit correction path: a follow-up replace_text lands as a
    // normal reviewable tracked change.
    const corrected = await applyTextOpsToDocx(bytes, [
      {
        op: "replace_text",
        scope: { kind: "whole_document" },
        find: "recieve",
        replace: "receive",
        whole_word: true,
      },
    ]);
    expect(corrected.replacementCount).toBe(1);
    const originalText = await extractDocxBodyText(bytes);
    const acceptedText = await resolveAll(corrected.bytes, corrected.edits, "accept");
    expect(acceptedText).toBe(originalText.replace("recieve", "receive"));
  });

  it("returns a clean no-op when nothing in scope changes", async () => {
    const bytes = await renderFixture();
    const applied = await applyTextOpsToDocx(bytes, [
      { op: "lowercase", scope: { kind: "find_text", text: "governs every dispute" } },
    ]);
    expect(applied.replacementCount).toBe(0);
    expect(applied.edits).toEqual([]);
    expect(applied.bytes).toBe(bytes);
  });
});

/**
 * The address layer resolves, the op engine executes. Both project the DOCX
 * with extractDocxBodyText, which is what makes an offset resolved for
 * reading valid for editing — the reason the second extractor was removed.
 */
describe("resolved-span scope", () => {
  it("applies only inside the spans it was handed", async () => {
    const bytes = await renderFixture();
    const text = await extractDocxBodyText(bytes);
    const start = text.indexOf("Purchaser shall pay");
    const end = text.indexOf("The parties recieve");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    const requests: TextOpRequest[] = [
      {
        op: "replace_text",
        find: "purchaser",
        replace: "buyer",
        scope: { kind: "spans", spans: [{ start, end }] },
      },
    ];
    const applied = await applyTextOpsToDocx(bytes, requests);
    const after = await resolveAll(applied.bytes, applied.edits, "accept");
    // Inside the span every occurrence moved; outside it none did.
    expect(after).toContain("The buyer may not assign");
    expect(after).toContain("Each buyer remains liable");
    expect(after).toContain("The governing law clause controls");
    expect(after.slice(0, start)).not.toContain("buyer");
  });

  it("refuses an empty resolved scope rather than falling back to the document", async () => {
    const bytes = await renderFixture();
    await expect(
      applyTextOpsToDocx(bytes, [
        {
          op: "uppercase",
          scope: { kind: "spans", spans: [{ start: 10, end: 10 }] },
        },
      ]),
    ).rejects.toThrow(/Resolved scope is empty/u);
  });
});
