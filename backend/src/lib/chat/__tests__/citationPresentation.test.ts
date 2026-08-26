import { describe, expect, it } from "vitest";

import {
  createA2AJPassageEvidence,
  createTnaEvidence,
  createPublicJournalPassageEvidence,
} from "../legalEvidence";
import { presentLegalEvidence } from "../citationPresentation";
import { structureNative } from "../../structureNative";

describe("legal evidence citation presentation", () => {
  it("owns authority, McGill locator, and source/passage destinations", async () => {
    const text = "The appeal is allowed.";
    const receipt = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:1",
      sourceText: text,
      spanText: text,
      citation: "2026 SCC 1",
      name: "Example v State",
      dataset: "fixture",
      externalUrl: "https://example.test/case",
      locatorKind: "paragraph",
      locatorLabel: "par12",
    });
    const source = await structureNative().deriveDocumentStructure({
      kind: "a2aj",
      input: { citation: receipt.citation, source_kind: "cases", text },
    });
    const presented = presentLegalEvidence({ receipt, source });
    expect(presented.authority).toBe("Example v State, 2026 SCC 1");
    expect(presented.locator).toEqual({ separator: " at ", text: "para 12" });
    expect(presented.sourceUrl).toBe("https://example.test/case");
    expect(presented.passageUrl).toContain("https://example.test/case#:~:text=");
    expect(presented.passageUrl).not.toContain("#par12");
  });

  it("does not invent a section anchor and keeps a unique passage intact", async () => {
    const span =
      "The court may, on application, vary that order, prospectively or retroactively.";
    const sourceText = [
      "The court may, on application, grant unrelated relief.",
      span,
    ].join("\n");
    const receipt = createTnaEvidence({
      jurisdiction: "CA-AB",
      sourceClass: "legislation",
      stableSourceId: "statute:family-law-act",
      sourceText,
      spanText: span,
      citation: "Family Law Act, SA 2003, c F-4.5",
      name: "Family Law Act",
      dataset: "fixture",
      externalUrl:
        "https://kings-printer.alberta.ca/1266.cfm?page=F04P5.cfm&leg_type=Acts&display=html",
      locatorKind: "section",
      locatorLabel: "sec77",
    });
    const source = await structureNative().deriveDocumentStructure({
      kind: "a2aj",
      input: {
        citation: receipt.citation,
        source_kind: "laws",
        text: sourceText,
      },
    });
    const presented = presentLegalEvidence({
      receipt,
      source,
    });

    expect(presented.passageUrl).toContain("display=html#:~:text=");
    expect(presented.passageUrl).not.toContain("#sec77");
    expect(presented.passageUrl).not.toContain(
      "application,that%20order",
    );
    const directive = decodeURIComponent(presented.passageUrl!.split("text=")[1]);
    expect(directive).toContain("The court may, on application, vary");
    expect(directive).toContain("retroactively.");
  });

  it("routes an A2AJ quote link through the official Decisia source", async () => {
    const text =
      "[42] The appellate court stated the distinctive controlling principle.";
    const url =
      "https://decisions.fca-caf.gc.ca/fca-caf/decisions/en/item/522310/index.do";
    const source = await structureNative().deriveDocumentStructure({
      kind: "a2aj",
      input: {
        citation: "2026 FCA 42",
        source_kind: "cases",
        text,
        dataset: "FCA",
        name: "Example v Canada",
        url,
      },
    });
    const document = {
      docType: "cases" as const,
      dataset: "FCA",
      citation: "2026 FCA 42",
      alternateCitation: null,
      name: "Example v Canada",
      date: null,
      url,
      verifiedPdf: null,
      language: "en" as const,
      upstreamLicense: null,
      searchText: text,
      searchNative: source,
      native: source,
    };
    const receipt = createA2AJPassageEvidence({
      citation: document.citation,
      name: document.name,
      dataset: document.dataset,
      language: document.language,
      sourceText: text,
      spanText: text,
      start: 0,
      end: text.length,
      externalUrl: url,
      sourceClass: "case",
      locator: { kind: "paragraph", label: "par42" },
    });
    const presented = presentLegalEvidence({
      receipt,
      document,
      source,
    });

    expect(presented.sourceUrl).toContain("canlii.org");
    expect(presented.passageUrl).toContain("decisions.fca-caf.gc.ca");
    expect(presented.passageUrl).toContain(
      "iframe=true&site_preference=mobile#par42:~:text=",
    );

    const documentPassage = presentLegalEvidence({
      receipt: {
        ...receipt,
        locator: { kind: "document", label: "document" },
      },
      document,
      source,
    });
    expect(documentPassage.sourceUrl).toContain("canlii.org");
    expect(documentPassage.passageUrl).toContain("decisions.fca-caf.gc.ca");
    expect(documentPassage.passageUrl).not.toContain("canlii.org");
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
    expect(presented.authority).toBe(
      "A Author, \u201cA Long Title\u201d (2025) 63:2 Alta L Rev 47",
    );
    expect(presented.locator).toEqual({ separator: " at ", text: "47" });
  });
});
