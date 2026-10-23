import { describe, expect, it } from "vitest";
import type { A2AJCompiledDocument } from "../legalSources/a2aj";
import { buildLegalSourcePinpoint } from "../legalSourceLinks";
import { structureNative } from "../structureNative";

async function nativeDocument(
  text: string,
  url = "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
  citation = "2099 SCC 1",
  dataset = "SCC",
): Promise<A2AJCompiledDocument> {
  const docType = url.includes("/laws/") ? "laws" as const : "cases" as const;
  const native = await structureNative().deriveDocumentStructure({
    kind: "provider_text",
    input: {
      provider: "a2aj", citation, source_kind: docType, text, dataset, url,
      require_report_start: docType === "cases" && dataset.toUpperCase() === "SCC",
    },
  });
  return {
    docType,
    dataset,
    citation,
    alternateCitation: null,
    name: docType === "laws" ? "Example Act" : "Example v. Example",
    date: null,
    url,
    verifiedPdf: null,
    language: "en",
    upstreamLicense: null,
    searchText: () => text,
    searchNative: native,
    native,
  };
}

async function nativeSource(text: string) {
  return (await nativeDocument(text)).native;
}

function textDirectives(url: string) {
  return (url.split(":~:", 2)[1] ?? "")
    .split("&")
    .filter((part) => part.startsWith("text="));
}

function paintedTerms(directive: string) {
  const pieces = directive.replace(/^text=/u, "").split(",");
  if (pieces[0]?.endsWith("-")) pieces.shift();
  if (pieces.at(-1)?.startsWith("-")) pieces.pop();
  return pieces.map(decodeURIComponent);
}

describe("verified legal-source links", () => {
  it("keeps PDF fragments split by A2AJ source lineation", async () => {
    const text = [
      '"settlement area" means, as the case may be,',
      "(a) the area described in appendix A to the",
      "Gwich'in Agreement,",
      "(c) the area described in appendix A to the",
      "Sahtu Agreement; (région désignée)",
      '"Tłı̨chǫ Agreement" means the Land Claims',
    ].join("\n");
    const blockText =
      "(c) the area described in appendix A to the Sahtu Agreement; " +
      '( région désignée ) " Tłı̨chǫ Agreement" means the Land Claims';
    const documentText = await structureNative().deriveDocumentStructure({
      kind: "provider_text",
      input: {
        provider: "a2aj",
        citation: "SNWT 2014, c 17",
        source_kind: "laws",
        text,
        dataset: "LEGISLATION-NT",
      },
    });
    const result = buildLegalSourcePinpoint({
      url: "https://example.test/laws/surface-rights-board.pdf",
      blockText,
      documentText,
    }, ["area described in appendix A to the Sahtu Agreement;"])!;

    expect(textDirectives(result.target)).not.toHaveLength(0);
    expect(result.plan?.sourceWordIntervals).not.toHaveLength(0);
  });

  it("paints every substantive island from one PDF quote", async () => {
    const text = "yukon alpha unique\nbilingual beta distinct";
    const result = buildLegalSourcePinpoint({
      url: "https://example.test/laws/example.pdf",
      blockText: text,
      documentText: await nativeSource(text),
    }, [text])!;

    expect(result.plan).toMatchObject({
      sourceSafeComplete: true,
      paintedWords: 6,
      paintQuotes: ["yukon alpha unique", "bilingual beta distinct"],
      sourceWordIntervals: [
        { quoteIndex: 0, firstWord: 0, lastWord: 2 },
        { quoteIndex: 0, firstWord: 3, lastWord: 5 },
      ],
    });
    expect(textDirectives(result.target)).toHaveLength(2);
  });

  it("exposes the complete source-word proof from the native planner", async () => {
    const text = "alpha beta gamma";
    const plan = structureNative().passageLink(await nativeSource(text),
      { url: "https://example.com/", blockText: text, quotes: [text] })?.plan;

    expect(plan).toMatchObject({
      sourceSafeComplete: true,
      paintedWords: 3,
      paintQuotes: [text],
      sourceWordIntervals: [{
        quoteIndex: 0,
        firstWord: 0,
        lastWord: 2,
      }],
    });
    expect(plan.directives).toHaveLength(1);
  });

  it("uses independently unique source blocks only for opted-in legislation", async () => {
    const text = "The following definitions apply in this Act.\nchild means the named person";
    const result = buildLegalSourcePinpoint({
      url: "https://web2.gov.mb.ca/laws/statutes/example.php",
      blockText: text,
      documentText: await nativeSource(text),
    }, [text], true)!;

    expect(textDirectives(result.target)).toHaveLength(2);
    expect(result.plan?.paintedWords).toBe(12);
    expect(result.plan?.sourceSafeComplete).toBe(true);
  });

  // The regression class the differential oracle caught: a quote that also
  // occurs verbatim earlier in the document. Planning against the whole
  // document disambiguates it; planning against the block alone cannot, and
  // Chrome then paints the earlier occurrence.

});
