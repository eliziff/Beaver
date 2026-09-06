import { expect, it } from "vitest";
import { groundedAnswerMarkdown, type GroundedEvidence } from "./groundedAnswers";

it("keeps claim support on original receipts, including repeated and missing references", () => {
  const receipt = { evidence_id: "original", provider: "library", stable_source_id: "workbook",
    version: "pinned-version", name: "Evidence.xlsx", citation: "Evidence.xlsx", span_text: "Actual source value",
    locator: { kind: "cell", label: "Orders!B2", sheet: "Orders", cells: "B2" } } as GroundedEvidence;
  const result = groundedAnswerMarkdown({ evidence: [receipt], claims: [
    { text: "First interpretation", evidence_ids: ["original", "original", "missing"] },
    { text: "Second interpretation", evidence_ids: ["original"] },
  ] });
  expect(result.text).toBe("First interpretation [1]\n\nSecond interpretation [1]");
  expect(result.citations).toEqual([expect.objectContaining({ kind: "document", ref: 1,
    document_id: "workbook", version_id: "pinned-version",
    quotes: [{ quote: "Actual source value", sheet: "Orders", cell: "B2" }] })]);
});
