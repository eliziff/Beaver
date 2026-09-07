import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  applyTrackedEdits,
  extractDocxBodyText,
  extractTrackedChangeIds,
  resolveTrackedChange,
  type EditInput,
} from "../docxTrackedChanges";

async function documentWith(text: string): Promise<Buffer> {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const paragraphs = escaped.split("\n").map((line) =>
    `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`,
  ).join("");
  return new JSZip()
    .file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`)
    .file("word/footer1.xml", "untouched footer")
    .generateAsync({ type: "nodebuffer" });
}

const edit = (fields: Partial<EditInput>): EditInput => ({
  find: "", replace: "X", context_before: "", context_after: "", ...fields,
});

describe("DOCX edit anchors", () => {
  it.each<{ name: string; text: string; input: Partial<EditInput>; expected: string }>([
    { name: "unique replacement", text: "left target right", input: { find: "target" }, expected: "left X right" },
    { name: "deletion", text: "left target right", input: { find: "target ", replace: "" }, expected: "left right" },
    {
      name: "before context selects a later match", text: "wrong target; chosen target",
      input: { find: "target", context_before: "chosen " }, expected: "wrong target; chosen X",
    },
    {
      name: "after context selects a later match", text: "target wrong; target right",
      input: { find: "target", context_after: " right" }, expected: "target wrong; X right",
    },
    {
      name: "both contexts must match the same occurrence", text: "a target b; a target c; d target b",
      input: { find: "target", context_before: "a ", context_after: " b" }, expected: "a X b; a target c; d target b",
    },
    {
      name: "a later overlapping match satisfies context", text: "aaaaZ",
      input: { find: "aa", context_after: "Z" }, expected: "aaXZ",
    },
    {
      name: "Unicode and collapsed whitespace map back to UTF-16 source offsets", text: "🦫\u00a0\u200b  “target”—end",
      input: { find: '"target"-', context_before: "🦫 ", context_after: "end" }, expected: "🦫\u00a0\u200b  Xend",
    },
    {
      name: "collapsed whitespace inside a replacement", text: "A \u00a0\u200bB",
      input: { find: "A B" }, expected: "X",
    },
    {
      name: "a normalized trailing space retains the rest of the source whitespace", text: "A   Z",
      input: { find: "A " }, expected: "X  Z",
    },
    { name: "insertion at the end", text: "Alpha", input: { context_before: "Alpha" }, expected: "AlphaX" },
    { name: "insertion at the start", text: "Alpha", input: { context_after: "Alpha" }, expected: "XAlpha" },
    {
      name: "both insertion contexts disambiguate a repeated anchor", text: "left wrong; left right",
      input: { context_before: "left ", context_after: "right" }, expected: "left wrong; left Xright",
    },
    {
      name: "insertion maps past collapsed source whitespace", text: "A   B",
      input: { context_before: "A ", context_after: "B" }, expected: "A   XB",
    },
    {
      name: "trusted exact spans bypass ambiguous text and unmatched context", text: "echo echo",
      input: { find: "echo", exact_start: 5, exact_end: 9, context_before: "absent" }, expected: "echo X",
    },
    {
      name: "multi-paragraph CRLF input uses original Unicode offsets", text: "🦫 Intro\nold\u00a0term\nold term\nTail",
      input: { find: "old term\r\nold term", replace: "new term\r\nnew term", context_before: "Intro\n", context_after: "\nTail" },
      expected: "🦫 Intro\nnew term\nnew term\nTail",
    },
    {
      name: "multi-paragraph context disambiguates repeated text", text: "A\nB\nA\nB\nTail",
      input: { find: "A\nB", replace: "X\nY", context_after: "\nTail" }, expected: "A\nB\nX\nY\nTail",
    },
  ])("$name round-trips through accept and reject", async ({ text, input, expected }) => {
    const applied = await applyTrackedEdits(await documentWith(text), [edit(input)]);
    expect(applied.errors).toEqual([]);
    expect(applied.changes).toHaveLength(1);
    await expect(extractDocxBodyText(applied.bytes)).resolves.toBe(expected);
    const ids = applied.changes.flatMap(({ delId, insId }) =>
      [delId, insId].filter((id): id is string => Boolean(id)),
    );
    for (const mode of ["accept", "reject"] as const) {
      const resolved = await resolveTrackedChange(applied.bytes, ids, mode);
      expect(resolved.found).toBe(true);
      await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(mode === "accept" ? expected : text);
      await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
    }
    const zip = await JSZip.loadAsync(applied.bytes);
    await expect(zip.file("word/footer1.xml")!.async("string")).resolves.toBe("untouched footer");
  });

  const missing = "Could not locate this edit on the current document text plane; the document is unchanged.";
  const ambiguous = "Ambiguous match for this edit; the document is unchanged.";
  it.each<{ name: string; text: string; input: Partial<EditInput>; reason: string }>([
    { name: "missing find", text: "abc", input: { find: "absent" }, reason: missing },
    { name: "before context outside the document", text: "abc", input: { find: "a", context_before: "z" }, reason: missing },
    { name: "after context outside the document", text: "abc", input: { find: "c", context_after: "z" }, reason: missing },
    { name: "overlapping replacements", text: "aaaa", input: { find: "aa" }, reason: ambiguous },
    { name: "overlapping before-only insertions", text: "aaa", input: { context_before: "aa" }, reason: ambiguous },
    { name: "overlapping after-only insertions", text: "aaa", input: { context_after: "aa" }, reason: ambiguous },
    { name: "unanchored insertion", text: "abc", input: {}, reason: "Pure insertion requires context_before or context_after." },
    { name: "empty edit", text: "abc", input: { replace: "" }, reason: "Empty edit." },
    {
      name: "before and find cannot share a collapsed boundary space", text: "A   B",
      input: { find: " B", context_before: "A " }, reason: missing,
    },
    {
      name: "find and after cannot share a collapsed boundary space", text: "A   B",
      input: { find: "A ", context_after: " B" }, reason: missing,
    },
    {
      name: "single-paragraph matching cannot span paragraph boundaries", text: "A\nB",
      input: { find: "A B" }, reason: missing,
    },
    {
      name: "ambiguous multi-paragraph replacement", text: "A\nB\nA\nB",
      input: { find: "A\nB", replace: "X\nY" }, reason: "Ambiguous match for the multi-paragraph edit; the document is unchanged.",
    },
    {
      name: "missing multi-paragraph replacement", text: "A\nB",
      input: { find: "A\nC", replace: "X\nY" }, reason: "Could not locate the multi-paragraph edit; the document is unchanged.",
    },
    {
      name: "multi-paragraph replacement must retain paragraph count", text: "A\nB",
      input: { find: "A\nB" }, reason: "Multi-paragraph replacement must preserve the paragraph count (2 found, 1 supplied).",
    },
    {
      name: "trusted exact spans still validate pinned text", text: "echo echo",
      input: { find: "echo", exact_start: 1, exact_end: 5 }, reason: "Exact edit span no longer matches the pinned text.",
    },
  ])("rejects $name without changing the document", async ({ text, input, reason }) => {
    const bytes = await documentWith(text);
    const applied = await applyTrackedEdits(bytes, [edit(input)]);
    expect(applied.errors).toEqual([{ index: 0, reason }]);
    expect(applied.changes).toEqual([]);
    // The package writer may reserialize XML/ZIP metadata even on rejection.
    await expect(extractDocxBodyText(applied.bytes)).resolves.toBe(text);
    await expect(extractTrackedChangeIds(applied.bytes)).resolves.toEqual([]);
    const zip = await JSZip.loadAsync(applied.bytes);
    await expect(zip.file("word/footer1.xml")!.async("string")).resolves.toBe("untouched footer");
  });
});
