import { describe, expect, it } from "vitest";
import { formatA2AJCoveragePrompt } from "./a2ajCoveragePrompt";
import type { A2AJCoverageResult } from "../a2aj";

function row(
  dataset: string,
  docType: "cases" | "laws",
  jurisdictionCode: A2AJCoverageResult["jurisdictionCode"],
  earliestDate: string,
  latestDate: string,
): A2AJCoverageResult {
  return {
    dataset,
    description: dataset,
    descriptionFr: null,
    docType,
    jurisdictionCode,
    jurisdiction: jurisdictionCode,
    sourceKind: docType === "cases" ? "court" : "legislation",
    earliestDate,
    latestDate,
    documentCount: 1,
  };
}

describe("formatA2AJCoveragePrompt", () => {
  it("exposes exact collection and date boundaries without implying corpus completeness", () => {
    const prompt = formatA2AJCoveragePrompt([
      row("BCSC", "cases", "BC", "2000-01-04", "2026-08-06"),
      row("LEGISLATION-BC", "laws", "BC", "1924-12-19", "2026-05-28"),
    ]);

    expect(prompt).toContain("Cases: BC: BCSC (2000-2026)");
    expect(prompt).toContain("Laws: BC: LEGISLATION-BC (1924-2026)");
    expect(prompt).toContain("Absence from A2AJ is not proof");
  });
});
