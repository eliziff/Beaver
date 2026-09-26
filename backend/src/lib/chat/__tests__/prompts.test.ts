import { expect, it } from "vitest";
import {
  legalSourceCoveragePrompt,
} from "../prompts";

it("renders installed A2AJ collections by jurisdiction and drops empty ones", () => {
  const prompt = legalSourceCoveragePrompt([
    { dataset: "SCC", docType: "cases", jurisdiction: "Federal", documentCount: 12 },
    { dataset: "FCA", docType: "cases", jurisdiction: "Federal", documentCount: 3 },
    { dataset: "ABCA", docType: "cases", jurisdiction: "Alberta", documentCount: 4 },
    { dataset: "LEGISLATION-AB", docType: "laws", jurisdiction: "Alberta", documentCount: 5 },
    { dataset: "EMPTY", docType: "cases", jurisdiction: "Nunavut", documentCount: 0 },
  ]);
  expect(prompt).not.toBeNull();
  expect(prompt).toContain("Case law — Alberta (ABCA); Federal (FCA, SCC).");
  expect(prompt).toContain("Legislation and regulations — Alberta (LEGISLATION-AB).");
  expect(prompt).not.toContain("Nunavut");
  expect(prompt).toContain("not available from A2AJ");
});

it("omits the coverage block when no collection is installed", () => {
  expect(legalSourceCoveragePrompt([])).toBeNull();
  expect(legalSourceCoveragePrompt([
    { dataset: "EMPTY", docType: "laws", jurisdiction: "Ontario", documentCount: 0 },
  ])).toBeNull();
});
