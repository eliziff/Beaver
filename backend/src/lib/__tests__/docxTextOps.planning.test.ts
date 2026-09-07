import { expect, it } from "vitest";
import { planTextOps, type TextOpRequest } from "../docxTextOps";

it.each<[string, string, number, Omit<TextOpRequest, "scope">]>([
  ["a", "xa", 1, { op: "replace_text", find: "a", replace: "xa" }],
  ["a", "ax", 1, { op: "replace_text", find: "a", replace: "ax" }],
  ["abc", "ac", 1, { op: "replace_text", find: "b", replace: "" }],
  ["a  b", "A  B", 1, { op: "uppercase" }],
  ["a   b", "A   B", 2, { op: "uppercase" }],
  ["alpha beta", "ALPHA BETA", 1, { op: "uppercase" }],
  ["a\n\nb", "A\n\nB", 2, { op: "uppercase" }],
  ["😀 élan", "😀 ÉLAN", 1, { op: "uppercase" }],
  ["ABC", "ABC", 0, { op: "uppercase" }],
])("plans paragraph-safe, scoped edits for %j → %j", async (before, after, count, operation) => {
  const prefix = "keep\n", suffix = "\ntail", doc = prefix + before + suffix;
  const { replacements, reports } = await planTextOps(doc, [{ ...operation,
    scope: { kind: "spans", spans: [{ start: prefix.length, end: prefix.length + before.length }] },
  }]);
  expect(replacements).toHaveLength(count);
  expect(reports).toEqual([{ op: operation.op, replacements: count, notes: [] }]);
  let result = doc;
  for (const { start, end, text } of [...replacements].reverse()) {
    expect(start).toBeGreaterThanOrEqual(prefix.length);
    expect(end).toBeLessThanOrEqual(prefix.length + before.length);
    expect(end).toBeGreaterThan(start);
    expect(doc.slice(start, end)).not.toContain("\n");
    expect(text).not.toContain("\n");
    result = result.slice(0, start) + text + result.slice(end);
  }
  expect(result).toBe(prefix + after + suffix);
});

it("rejects an operation that adds a paragraph", async () => {
  await expect(planTextOps("a\nb", [{ op: "replace_text", find: "a", replace: "a\n",
    scope: { kind: "whole_document" },
  }])).rejects.toThrow(/paragraph boundar/);
});
