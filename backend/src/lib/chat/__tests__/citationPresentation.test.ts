import { describe, expect, it } from "vitest";

import {
  createBenchmarkEvidence,
  createPublicJournalPassageEvidence,
} from "../legalEvidence";
import {
  citationPresentationText,
  presentLegalEvidence,
} from "../citationPresentation";

describe("legal evidence citation presentation", () => {
  it("owns authority, McGill locator, and source/passage destinations", () => {
    const receipt = createBenchmarkEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:1",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      citation: "2026 SCC 1",
      name: "Example v State",
      dataset: "fixture",
      externalUrl: "https://example.test/case",
      locatorKind: "paragraph",
      locatorLabel: "par12",
    });
    const presented = presentLegalEvidence({ receipt });
    expect(citationPresentationText(presented.authority)).toBe("Example v State, 2026 SCC 1");
    expect(presented.locator).toEqual({ separator: " at ", text: "para 12" });
    expect(presented.sourceUrl).toBe("https://example.test/case");
    expect(presented.passageUrl).toContain("https://example.test/case#par12:~:text=");
  });

  it("does not prepend a journal title to its finished authority", () => {
    const receipt = createPublicJournalPassageEvidence({
      citation: "A Author, \u201cA Long Title\u201d (2025) 63:2 Alta L Rev 47",
      name: "A Long Title",
      date: "2025",
      url: "https://example.test/article",
      text: "This is the exact journal passage.",
      articleId: "article-1",
      locatorKind: "page",
      locatorLabel: "page47",
    });
    const presented = presentLegalEvidence({ receipt });
    expect(citationPresentationText(presented.authority)).toBe(
      "A Author, \u201cA Long Title\u201d (2025) 63:2 Alta L Rev 47",
    );
    expect(presented.locator).toEqual({ separator: " at ", text: "47" });
  });
});
