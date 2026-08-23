import { describe, expect, it } from "vitest";

import {
  createA2AJLookupEvidence,
  createTnaEvidence,
  createPublicJournalPassageEvidence,
} from "../legalEvidence";
import {
  citationPresentationText,
  presentLegalEvidence,
} from "../citationPresentation";
import type { A2AJLocatorLookup } from "../../legalSources/a2aj";

const textSource = (text: string) => ({ text });

describe("legal evidence citation presentation", () => {
  it("owns authority, McGill locator, and source/passage destinations", () => {
    const receipt = createTnaEvidence({
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
    expect(presented.passageUrl).toContain("https://example.test/case#:~:text=");
    expect(presented.passageUrl).not.toContain("#par12");
  });

  it("does not invent a section anchor and keeps a unique passage intact", () => {
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
    const presented = presentLegalEvidence({
      receipt,
      source: textSource(sourceText),
    });

    expect(presented.passageUrl).toContain("display=html#:~:text=");
    expect(presented.passageUrl).not.toContain("#sec77");
    expect(presented.passageUrl).not.toContain(
      "application,that%20order",
    );
    expect(decodeURIComponent(presented.passageUrl!.split("text=")[1])).toBe(span);
  });

  it("routes A2AJ quote links through the official Decisia source", () => {
    const text =
      "[42] The appellate court stated the distinctive controlling principle.";
    const lookup: A2AJLocatorLookup = {
      status: "found",
      citation: "2026 FCA 42",
      alternateCitation: null,
      name: "Example v Canada",
      dataset: "FCA",
      url: "https://decisions.fca-caf.gc.ca/fca-caf/decisions/en/item/522310/index.do",
      language: "en",
      requested: { kind: "paragraph", locator: "42", label: "par42" },
      matches: ["par42"],
      block: {
        kind: "paragraph",
        label: "par42",
        start: 0,
        end: text.length,
        origin: "native",
        text,
      },
      before: [],
      after: [],
      structure: {
        status: "usable",
        source: "flat_text",
        counts: { paragraph: 1, page: 0, section: 0 },
      },
      sourceMethod: "structure_index",
    };
    const receipt = createA2AJLookupEvidence(lookup)!;
    const presented = presentLegalEvidence({
      receipt,
      lookup,
      source: textSource(text),
    });

    expect(presented.sourceUrl).toContain("canlii.org");
    expect(presented.passageUrl).toContain("decisions.fca-caf.gc.ca");
    expect(presented.passageUrl).toContain(
      "iframe=true&site_preference=mobile#par42:~:text=",
    );

    const restored = presentLegalEvidence({
      receipt,
      document: {
        docType: "cases",
        dataset: lookup.dataset,
        citation: lookup.citation,
        alternateCitation: lookup.alternateCitation,
        name: lookup.name,
        date: null,
        url: lookup.url,
        text,
        language: lookup.language,
        upstreamLicense: null,
        structure: lookup.structure,
      },
      source: textSource(text),
    });
    expect(restored.passageUrl).toContain("decisions.fca-caf.gc.ca");
    expect(restored.passageUrl).toContain("#par42:~:text=");

    const documentPassage = presentLegalEvidence({
      receipt: {
        ...receipt,
        locator: { kind: "document", label: "document" },
      },
      document: {
        docType: "cases",
        dataset: lookup.dataset,
        citation: lookup.citation,
        alternateCitation: lookup.alternateCitation,
        name: lookup.name,
        date: null,
        url: lookup.url,
        text,
        language: lookup.language,
        upstreamLicense: null,
        structure: lookup.structure,
      },
      source: textSource(text),
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
    expect(citationPresentationText(presented.authority)).toBe(
      "A Author, \u201cA Long Title\u201d (2025) 63:2 Alta L Rev 47",
    );
    expect(presented.locator).toEqual({ separator: " at ", text: "47" });
  });
});
