import { describe, expect, it } from "vitest";
import type { A2AJCompiledDocument } from "../legalSources/a2aj";
import {
  buildLegalSourcePinpoint,
  buildLegalSourcePinpointUrl,
} from "../legalSourceLinks";
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

  it("uses a verified PDF when it proves more source words than HTML", async () => {
    const word = "xylophonic";
    const result = buildLegalSourcePinpointUrl({
      url: "https://example.test/reasons.html",
      verifiedPdf: {
        url: "https://example.test/reasons.pdf",
        pdfOnly: false,
      },
      blockText: word,
      documentText: await nativeSource(word),
    }, [word]);

    expect(result).toBe("https://example.test/reasons.pdf#:~:text=xylophonic");
  });

  it("treats source line wrapping as whitespace when proving uniqueness", async () => {
    const text = "A phrase split across\na source line remains one rendered passage.";
    const document = await nativeDocument(text);
    const result = buildLegalSourcePinpointUrl({
      url: document.url!,
      blockText: "A phrase split across a source line remains one rendered passage.",
      documentText: document.native,
    }, ["phrase split across a source line"]);

    expect(textDirectives(result!)).toHaveLength(1);
    expect(paintedTerms(textDirectives(result!)[0]!)).toEqual([
      "phrase split across",
      "a source line",
    ]);
  });

  it("uses range endpoints across interior legal-reference seams", async () => {
    const text = "duties arise under sections 5.1.1 annotation follows";
    const documentText = await nativeSource(text);
    const bclaws = buildLegalSourcePinpointUrl({
      url: "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01",
      blockText: text,
      documentText,
    }, [text])!;
    const ordinary = buildLegalSourcePinpointUrl({
      url: "https://example.test/statute",
      blockText: text,
      documentText,
    }, [text])!;

    expect(textDirectives(bclaws)).toHaveLength(1);
    expect(textDirectives(ordinary)).toHaveLength(1);
    expect(paintedTerms(textDirectives(bclaws)[0]!)).toHaveLength(2);
  });

  it("links a quote carrying an editorial alteration", async () => {
    // A court quoting mid-sentence writes "[T]he ...". The words match the
    // source, but the raw quote never equals the rendered text, so when the
    // passage repeats, disambiguation used to reject every candidate and the
    // link was dropped. The alteration-resolved form is compared too.
    const blockText =
      "Parliament said the following. " +
      "The duty of care applies to every occupier of the premises. " +
      "It also said, the duty of care applies to every occupier of the premises.";
    const evidence = {
      url: "https://example.test/decision",
      blockText,
      documentText: await nativeSource(blockText),
    };
    const result = buildLegalSourcePinpointUrl(evidence, [
      "[T]he duty of care applies to every occupier of the premises.",
    ])!;

    expect(result).toBe("https://example.test/decision");
    // Browser-order replay emits the deterministic first source occurrence.
    expect(paintedTerms(textDirectives(
      buildLegalSourcePinpointUrl(evidence, ["of the premises"])!,
    )[0]!)).toEqual(["of the premises"]);
  });

  it("allows same-origin viewer paths and rejects unsafe relative URLs", async () => {
    const blockText = "First exact passage. A second exact passage.";
    const evidence = {
      url: "/single-documents/doc-1/file?rendition=pdf&version_id=version-1#page=1",
      blockText,
      documentText: await nativeSource(blockText),
      pageScoped: true,
    };
    const result = buildLegalSourcePinpointUrl(evidence, [
      "First exact passage",
      "second exact passage",
    ]);

    expect(result).toContain(
      "/single-documents/doc-1/file?rendition=pdf&version_id=version-1#page=1:~:text=",
    );
    expect(result?.match(/text=/gu)).toHaveLength(2);
    for (const url of [
      "//evil.example/path",
      "/\\evil.example/path",
      "javascript:alert(1)",
    ]) {
      expect(
        buildLegalSourcePinpointUrl({ ...evidence, url }, [
          "First exact passage",
        ]),
      ).toBeNull();
    }
  });

  it("keeps a long source-safe passage as one compact range", async () => {
    const quote =
      "[101] Delay in seeking child support can prejudice both parties, but the applicable factors must not be decided arbitrarily not to apply.";
    const text = [
      "Delay in seeking child support may arise for unrelated reasons in another part of the judgment.",
      quote,
    ].join("\n");
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html",
        anchor: "par101",
        blockText: quote,
        documentText: await nativeSource(text),
      },
      [quote],
    )!;
    const directives = textDirectives(result);
    expect(directives).toHaveLength(1);
    expect(paintedTerms(directives[0]!)).toEqual([
      "Delay in seeking child support can prejudice both parties, but the applicable factors must not be decided arbitrarily not to apply",
    ]);
  });

  it("never carries A2AJ pin-range artifacts into fragment targets", async () => {
    const passage =
      "The court must ensure that the quantum of a retroactive award fits the circumstances.";
    const blockText = `${passage} [99-135]`;
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2311/index.do",
        anchor: "par135",
        blockText,
        documentText: await nativeSource(passage),
      },
      [blockText],
    )!;

    // The bracketed range is citation presentation appended to the receipt
    // span; it never appears on the page, so a target containing it can
    // only fail.
    expect(paintedTerms(textDirectives(result)[0]!)).toEqual([
      "The court must ensure that the quantum of a retroactive award fits the circumstances",
    ]);
    expect(result).not.toContain("99%2D135");
  });

  it("keeps safe margin numbers and drops provision labels", async () => {
    const decisiaText =
      "5 Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders.";
    const decisia = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2311/index.do",
        anchor: "par5",
        blockText: decisiaText,
        documentText: await nativeSource(decisiaText),
      },
      [
        "5 Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders.",
      ],
    )!;
    expect(paintedTerms(textDirectives(decisia)[0]!)).toEqual([
      "Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders",
    ]);

    const kingsPrinter =
      "https://kings-printer.alberta.ca/1266.cfm?page=F04P5.cfm&leg_type=Acts&isbncln=9780779854820&display=html";
    const subsectionText = "(2) The court may make a child support order only if";
    const subsection = buildLegalSourcePinpointUrl(
      {
        url: kingsPrinter,
        blockText: subsectionText,
        documentText: await nativeSource(subsectionText),
      },
      ["(2) The court may make a child support order only if"],
    )!;
    expect(paintedTerms(textDirectives(subsection)[0]!)).toEqual([
      "The court may make a child support order only if",
    ]);
    expect(subsection).not.toContain("text=%282%29");

    const sectionText =
      "51 (1) In making a child support order, the court shall do so in accordance with the prescribed guidelines.";
    const section = buildLegalSourcePinpointUrl(
      {
        url: kingsPrinter,
        blockText: sectionText,
        documentText: await nativeSource(sectionText),
      },
      [
        "51 (1) In making a child support order, the court shall do so in accordance with the prescribed guidelines.",
      ],
    )!;
    expect(paintedTerms(textDirectives(section)[0]!)).toEqual([
      "In making a child support order, the court shall do so in accordance with the prescribed guidelines",
    ]);
    expect(section).not.toContain("text=51");
  });

  it("covers source-line seams with one compact range by default", async () => {
    const para =
      "[130] A second way courts can affect the quantum of retroactive awards is by altering the time period that the award captures while keeping fairness in view.";
    const blockText = `${para}\n5.5 Summary`;
    const documentText = `${blockText}\n[131] A later paragraph continues with further distinct reasoning.`;
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html",
        anchor: "par130",
        blockText,
        documentText: await nativeSource(documentText),
      },
      [blockText],
    )!;
    const directives = textDirectives(result);
    expect(directives).toHaveLength(1);
    expect(paintedTerms(directives[0]!)).toEqual([
      "A second way",
      "5.5 Summary",
    ]);
    expect(directives.join("&")).not.toMatch(/%0A/iu);
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

  it("falls back to the anchor when a cross-line passage cannot be verified", async () => {
    const para =
      "An unverifiable cross-line passage repeats twice in the judgment with no distinguishing context anywhere.";
    const blockText = `${para}\nAppendix`;
    const documentText = `${blockText}\n${blockText}`;
    const url = "https://example.test/decision";
    expect(
      buildLegalSourcePinpointUrl(
        {
          url,
          anchor: "par7",
          blockText,
          documentText: await nativeSource(documentText),
        },
        [blockText],
      ),
    ).toBe(`${url}#par7`);
  });

  it("does not multiply a source spelling into speculative variants", async () => {
    const passage =
      "This appeal centres on the appropriate framework for determining applications to retroactively decrease child support arrears under s. 17 of the Divorce Act and related provisions.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18909/index.do",
        anchor: "par1",
        blockText: passage,
        documentText: await nativeSource(passage),
      },
      [
        "retroactively decrease child support arrears under s. 17 of the Divorce Act and related provisions",
      ],
    )!;

    const directives = textDirectives(result);
    expect(directives).toHaveLength(1);
    expect(paintedTerms(directives[0]!)).toEqual([
      "retroactively decrease child",
      "and related provisions.",
    ]);
  });

  it("keeps single-directive output when no citation cluster is present", async () => {
    const passage =
      "The amount of child support payable varies based on the payor income and often fluctuates.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18909/index.do",
        anchor: "par1",
        blockText: passage,
        documentText: await nativeSource(passage),
      },
      ["child support payable varies based on the payor income"],
    )!;
    expect(result.match(/text=/gu)).toHaveLength(1);
  });

  it("plans Competition Tribunal fragments with PDF seam rules", async () => {
    const text = [
      "Unique lead",
      "Alpha one",
      "Beta two",
      "Tail end",
      "Other lead",
      "Alpha one",
      "Beta two",
      "Other end",
    ].join("\n");
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/464444/index.do",
        verifiedPdf: {
          url: "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/464444/1/document.do",
          pdfOnly: true,
        },
        anchor: "par22",
        blockText: "Unique lead\nAlpha one\nBeta two\nTail end",
        documentText: await nativeSource(text),
      },
      ["Alpha one\nBeta two"],
    )!;

    expect(result).toMatch(
      /^https:\/\/decisions\.ct-tc\.gc\.ca\/ct-tc\/cdo\/en\/464444\/1\/document\.do#:~:text=/u,
    );
  });

  it("drops HTML paragraph anchors from resolved PDF documents", async () => {
    const passage = "The Applicant relied heavily on the previous decision.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisia.lexum.com/nsc/nssc/en/459053/1/document.do",
        anchor: "par17",
        blockText: passage,
        documentText: await nativeSource(passage),
      },
      [passage],
    )!;
    expect(result).toMatch(/\/document\.do#:~:text=/u);
    expect(result).not.toContain("#par17");
  });

  // The regression class the differential oracle caught: a quote that also
  // occurs verbatim earlier in the document. Planning against the whole
  // document disambiguates it; planning against the block alone cannot, and
  // Chrome then paints the earlier occurrence.
  it("disambiguates a quote that repeats elsewhere in the document", async () => {
    const repeated = "the applicant bears the burden of establishing prejudice";
    const text = [
      `[1] In an earlier passage the Court noted that ${repeated}.`,
      "[2] Intervening discussion of an unrelated procedural question.",
      `[3] For the reasons that follow, ${repeated} on this appeal.`,
    ].join("\n\n");
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
        blockText: `[3] For the reasons that follow, ${repeated} on this appeal.`,
        documentText: await nativeSource(text),
      },
      [repeated],
    )!;
    // A bare `text=<quote>` would land on paragraph 1, so the plan must pin
    // the cited occurrence with prefix (`prefix-,`) or suffix (`,-suffix`)
    // context drawn from the surrounding source text.
    const directives = decodeURIComponent(result.slice(result.indexOf(":~:") + 3));
    expect(directives).toMatch(/-,|,-/u);
    expect(directives.startsWith("text=follow,-") ||
      directives.includes(",-on")).toBe(true);
  });

});
