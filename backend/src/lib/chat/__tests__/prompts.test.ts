import { expect, it } from "vitest";
import {
  CLIENT_WORK_PRODUCT_PRESUMPTION,
  CODING_PRODUCTION_SYSTEM_PROMPT,
  JOURNALS_AND_COMMENTARY_GUIDANCE,
  SOURCE_SEARCH_SYSTEM_PROMPT,
  legalSourceCoveragePrompt,
} from "../prompts";

it("routes doctrinal work into Journals in every research prompt", () => {
  for (const prompt of [CODING_PRODUCTION_SYSTEM_PROMPT, SOURCE_SEARCH_SYSTEM_PROMPT]) {
    expect(prompt).toContain(JOURNALS_AND_COMMENTARY_GUIDANCE);
    expect(prompt).toContain("Doctrinal research should usually include reading Journals");
    expect(prompt).toContain("non-binding");
  }
  expect(JOURNALS_AND_COMMENTARY_GUIDANCE).toContain("unless the final synthesis naturally excludes it");
  expect(CLIENT_WORK_PRODUCT_PRESUMPTION).not.toContain("JOURNALS");
});

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
