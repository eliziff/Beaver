import { describe, expect, it } from "vitest";

import {
  createA2AJPassageEvidence,
  createTnaEvidence,
  createPublicJournalPassageEvidence,
  legalSourceEvidence,
} from "../legalEvidence";
import { createLegalEvidenceCitationsFromEntries, createLegalSourceSearchCitations } from "../citations";
import { presentLegalEvidence } from "../citationPresentation";
import { structureNative } from "../../structureNative";

describe("legal evidence citation presentation", () => {
  it("highlights every grouped passage without filling gaps, and bounds oversized groups", async () => {
    const paragraphs = [
      "[43] Consultation must be meaningful.",
      "[44] Deep consultation requires submissions and written reasons.",
      "[45] Every case must be approached individually and flexibly.",
      "[46] This intervening passage is not cited.",
      "[47] Accommodation may require changes to the proposed action.",
      "[48] The process does not confer a veto.",
      "[49] The parties must seek a reasonable compromise.",
    ];
    const text = paragraphs.join("\n\n");
    const url = "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2189/index.do";
    const source = await structureNative().deriveDocumentStructure({ kind: "provider_text",
      input: { provider: "a2aj", citation: "2004 SCC 73", source_kind: "cases", text } });
    const entries = paragraphs.map((spanText, index) => ({ source,
      receipt: createA2AJPassageEvidence({ citation: "2004 SCC 73", name: "Haida Nation",
        dataset: "SCC", language: "en", sourceText: text, spanText,
        start: text.indexOf(spanText), end: text.indexOf(spanText) + spanText.length,
        externalUrl: url, sourceClass: "case", locator: { kind: "paragraph", label: `par${43 + index}` } }),
    }));
    const fragment = (selected: typeof entries) => {
      const [citation] = createLegalEvidenceCitationsFromEntries(selected);
      return { citation, text: decodeURIComponent(String(citation.url).split(":~:text=")[1] ?? "") };
    };
    const pair = fragment(entries.slice(1, 3));
    expect(pair.citation.pinpoint).toBe("paras 44\u201345");
    expect(pair.text).toContain("Deep");
    expect(pair.text).toContain("Every");
    expect(pair.text).not.toContain("[44]");
    const distant = fragment([entries[1], entries[4]]);
    expect(distant.text).toContain("Accommodation");
    expect(distant.text).not.toContain("intervening");
    expect(fragment(entries.slice(0, 5)).text).not.toBe("");
    const overLimit = fragment(entries.slice(0, 6));
    expect(overLimit.citation.pinpoint).toBe("paras 43\u201348");
    expect(overLimit.text).toBe("");
    expect(overLimit.citation.quotes).toHaveLength(6);
    const changedVersion = fragment([entries[1], { ...entries[2],
      receipt: { ...entries[2].receipt, source_sha256: "different-version" } }]);
    expect(changedVersion.text).toBe("");
    const missingPassage = fragment([entries[1], { ...entries[2],
      receipt: { ...entries[2].receipt, span_text: "This passage does not occur in the source." } }]);
    expect(missingPassage.text).toBe("");
  });

  it("uses a plain source link for a passage beyond the highlight word budget", async () => {
    const text = Array.from({ length: 1_501 }, (_, index) => `word${index}`).join(" ");
    const source = await structureNative().deriveDocumentStructure({ kind: "provider_text",
      input: { provider: "tna", citation: "Fixture", source_kind: "cases", text } });
    const receipt = createTnaEvidence({ jurisdiction: "UK", sourceClass: "case",
      stableSourceId: "fixture", sourceText: text, spanText: text, citation: "Fixture",
      name: "Fixture", dataset: "fixture", externalUrl: "https://example.test/long-case",
      locatorKind: "paragraph", locatorLabel: "par1" });
    expect(presentLegalEvidence({ receipt, source })).toMatchObject({
      passageUrl: "https://example.test/long-case", locator: { text: "para 1" },
    });
  });
  it("keeps discovered public source identity while preserving exact passage links and receipts", async () => {
    const text = "The appeal is allowed.";
    const document = await structureNative().deriveDocumentStructure({
      kind: "provider_text", input: { provider: "a2aj", citation: "Fixture", source_kind: "cases", text },
    });
    for (const provider of ["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"] as const) {
      const source = { provider, id: "source-1", kind: provider === "journal" || provider === "hansard"
        ? provider : "case" as const, title: "Example", citation: "Fixture", collection: "fixture",
        url: "https://example.test/source", ...(provider === "courtlistener" && { part: "7" }) };
      const receipt = legalSourceEvidence({ source, role: "selected", text, documentArtifact: document,
        locator: { requested: { kind: "paragraph", value: "12" }, label: "par12" } })!;
      const original = structuredClone(receipt);
      const [citation] = createLegalEvidenceCitationsFromEntries([{ receipt, source: document }]);
      const [discovered] = createLegalSourceSearchCitations([{ ...source,
        id: source.id, kind: source.kind }]);
      expect(citation.identifier).toBe(discovered.identifier);
      expect(citation).toMatchObject({ provider, identifier: source.id,
        external_url: source.url, url: expect.stringContaining(`${source.url}#:~:text=`),
        locator_kind: "paragraph", locator: "12", quotes: [{ quote: text }] });
      expect(receipt).toEqual(original);
      expect(receipt.source_sha256).toBe(structureNative().documentRevision(document));
    }
  });

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
      kind: "provider_text",
      input: { provider: "a2aj", citation: receipt.citation, source_kind: "cases", text },
    });
    const presented = presentLegalEvidence({ receipt, source });
    expect(presented.authority).toBe("Example v State, 2026 SCC 1");
    expect(presented.locator).toEqual({ separator: " at ", text: "para 12", label: "12" });
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
      kind: "provider_text",
      input: {
        provider: "a2aj",
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
      kind: "provider_text",
      input: {
        provider: "a2aj",
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
    expect(presented.locator).toEqual({ separator: " at ", text: "47", label: "47" });
  });
});
