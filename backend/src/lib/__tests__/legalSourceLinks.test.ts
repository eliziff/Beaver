import { describe, expect, it } from "vitest";
import type { A2AJCompiledDocument } from "../legalSources/a2aj";
import {
  buildA2AJDocumentPinpointUrl,
  buildLegalSourcePinpoint,
  buildLegalSourcePinpointUrl,
  shouldUseA2AJWebFallback,
} from "../legalSourceLinks";
import { structureNative, type NativeTextFragmentPlan } from "../structureNative";
import { buildA2AJWebPinpointUrl } from "../a2ajWebLinks";

async function nativeDocument(
  text: string,
  url = "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
  citation = "2099 SCC 1",
  dataset = "SCC",
): Promise<A2AJCompiledDocument> {
  const docType = url.includes("/laws/") ? "laws" as const : "cases" as const;
  const native = await structureNative().deriveDocumentStructure({
    kind: "a2aj",
    input: { citation, source_kind: docType, text, dataset, url },
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
    searchText: text,
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
      kind: "a2aj",
      input: {
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
    const plan = structureNative().textFragmentPlan(
      text,
      [text],
      false,
      false,
      false,
      await nativeSource(text),
    );

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
      "phrase",
      "line",
    ]);
  });

  it("uses the BCLaws human page and section anchor", async () => {
    const text = "19.15 (1) An arbitrator may correct an award on application.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/00_11025_00_multi/xml",
        anchor: "sec19.15",
        blockText: text,
        documentText: await nativeSource(text),
      },
      ["An arbitrator may correct an award on application."],
    );

    expect(result).toContain("00_11025_00_multi#section19.15:~:text=");
    expect(result).not.toContain("/xml");

    const nestedText = "The subsection applies to this exact legal proposition.";
    const nested = buildLegalSourcePinpointUrl(
      {
        url: "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/00_11025_00_multi/xml",
        anchor: "sec249.1(2)(a)(ii)",
        blockText: nestedText,
        documentText: await nativeSource(nestedText),
      },
      ["subsection applies to this exact legal proposition"],
    );
    expect(nested).toContain("#section249.1:~:text=");
    expect(nested).not.toContain("section249.1(2)");
  });

  it("uses range endpoints across interior legal-reference seams", async () => {
    const text = "duties arise under sections 5.1.1 annotation follows";
    const documentText = await nativeSource(text);
    const bclaws = buildLegalSourcePinpointUrl({
      url: "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/example/xml",
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

  it("uses the Justice Laws public page instead of its raw XML feed", async () => {
    const text = "The applicable table is determined under these Guidelines.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://laws-lois.justice.gc.ca/eng/XML/SOR-97-175.xml",
        blockText: text,
        documentText: await nativeSource(text),
      },
      ["The applicable table is determined under these Guidelines."],
    );

    expect(result).toContain(
      "https://laws-lois.justice.gc.ca/eng/regulations/SOR-97-175/FullText.html#:~:text=",
    );
    expect(result).not.toContain("/XML/");
  });

  it("keeps paragraph markers out of CanLII text targets", async () => {
    const text = "[38] I will note that fentanyl and some other controlled substances are inherently toxic, whether in the control of the accused or not.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/bc/bcsc/doc/2024/2024bcsc2224/2024bcsc2224.html",
        anchor: "par38",
        blockText: text,
        documentText: await nativeSource(text),
      },
      ["[38] I will note that fentanyl and some other controlled substances are inherently toxic, whether in the control of the accused or not."],
    );

    expect(textDirectives(result!)).toHaveLength(1);
    expect(paintedTerms(textDirectives(result!)[0]!)).toEqual([
      "I",
      "not.",
    ]);
    expect(result).not.toContain("text=38%5D");
  });
  it.each([
    [
      "paragraph",
      "para 42",
      "par42",
      "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
      "#par42",
    ],
    [
      "section",
      "s. 672.54(b)",
      "sec672.54(b)",
      "https://www.canlii.org/en/ca/laws/stat/rsc-1985-c-c-46/latest/rsc-1985-c-c-46.html",
      "#sec672.54",
    ],
    [
      "page",
      "page 19",
      "page19",
      "https://example.test/article.pdf",
      "#page=19",
    ],
  ] as const)("anchors an A2AJ %s passage", async (kind, _locator, label, url, anchor) => {
    const text =
      "The distinctive source words establish this proposition conclusively.";
    const document = await nativeDocument(text, url);

    const result = buildA2AJDocumentPinpointUrl(
      document,
      { kind, label },
      text,
      ["distinctive source words establish this proposition"],
    );

    expect(result).toContain(`${anchor}:~:text=`);
  });

  it("builds exact encoded multi-text directives and deduplicates quotes", async () => {
    const text =
      "6 A self-regulating & independent profession acts in the public interest. " +
      "A frivolous, vexatious request may be denied.";
    const document = await nativeDocument(
      text,
      "https://www.canlii.org/en/ca/laws/stat/example/latest/example.html",
    );
    const result = buildA2AJDocumentPinpointUrl(
      document,
      { kind: "section", label: "sec6" },
      text,
      [
        "self-regulating & independent profession",
        "frivolous, vexatious request",
        "self-regulating & independent profession",
      ],
    )!;

    expect(result.match(/text=/gu)).toHaveLength(2);
    expect(result).toContain("&text=");
    expect(paintedTerms(textDirectives(result)[0]!)).toEqual([
      "self-regulating",
      "profession",
    ]);
    expect(paintedTerms(textDirectives(result)[1]!)).toEqual([
      "frivolous,",
      "request",
    ]);
    const partial = buildA2AJDocumentPinpointUrl(
        document,
        { kind: "section", label: "sec6" },
        text,
        ["self-regulating & independent profession", "not present in source"],
      )!;
    expect(textDirectives(partial)).toHaveLength(1);
    expect(paintedTerms(textDirectives(partial)[0]!)).toEqual([
      "self-regulating",
      "profession",
    ]);
  });

  it("builds an actual A2AJ document-view fallback with native directives", () => {
    const source = {
      docType: "cases",
      citation: "1980 BCCA 1",
    } as const;
    const plan = {
      directives: ["text=amount,Act", "text=amount,payable"],
      sourceWordIntervals: [{
        quoteIndex: 0, start: 4, end: 61, firstWord: 1, lastWord: 11,
      }],
      sourceSafeComplete: true,
      paintedWords: 10,
      paintQuotes: [
        "amount was $200,000.00 under the Act",
        "amount was $200,000.00 under the Act and remains payable",
      ],
    };
    const target = buildA2AJWebPinpointUrl(source, plan)!;
    expect(target).toBe(
      "https://law.a2aj.ca/document?citation=1980+BCCA+1&doc_type=cases" +
      "#:~:text=amount,Act&text=amount,payable",
    );
    expect(buildA2AJWebPinpointUrl(source, {
      ...plan,
      sourceSafeComplete: false,
    })).toBeNull();
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
    )[0]!)).toEqual(["of", "premises."]);
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

  it("routes a proved unique SCC plan through Law Web", async () => {
    const text = `${"Background context. ".repeat(70)
      }The court described the motiveless act as unusual in all the circumstances.`;
    const document = await nativeDocument(
      text,
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/21212/index.do" +
        "?foo=bar&iframe=false&site_preference=desktop",
    );
    const result = buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par191" },
      text,
      ["motiveless act"],
    )!;

    expect(result).toContain(
      "https://law.a2aj.ca/document?citation=2099+SCC+1&doc_type=cases#:~:text=",
    );
    expect(paintedTerms(textDirectives(result)[0]!)).toEqual(["motiveless act"]);
  });

  it("keeps a context-resolved repeated SCC passage on the publisher", async () => {
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
    const document = await nativeDocument(
      text,
      "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/21213/index.do",
    );
    const result = buildA2AJDocumentPinpointUrl(
      { ...document, verifiedPdf: {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/21213/1/document.do",
        pdfOnly: false,
      } },
      { kind: "paragraph", label: "par1" },
      "Unique lead\nAlpha one\nBeta two\nTail end",
      ["Alpha one\nBeta two"],
    )!;

    expect(result).toContain("https://decisions.scc-csc.ca/");
    expect(result).toContain("iframe=true&site_preference=mobile");
  });

  it("uses the proved SCC fallback only when a fragment is requested", async () => {
    const text = `${"Background context. ".repeat(70)
      }[81] In section 2(b) jurisprudence, counter-speech remains a central consideration.`;
    const document = await nativeDocument(
      text,
      "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do",
      "2023 SCC 14",
    );

    expect(buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par81" },
      text,
      [],
    )).toBe(
      "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do?iframe=true&site_preference=mobile#par81",
    );
    expect(buildA2AJDocumentPinpointUrl(
      { ...document, url: null },
      { kind: "paragraph", label: "par81" },
      text,
      [],
    )).toBeNull();
    expect(buildA2AJDocumentPinpointUrl(
      { ...document, url: null },
      { kind: "paragraph", label: "par81" },
      text,
      ["counter-speech remains a central consideration"],
    )).toContain("https://law.a2aj.ca/document?citation=2023+SCC+14&doc_type=cases#:~:text=");
    const official = await nativeDocument(
      "[12] The Alberta court states the governing rule.",
      "https://example.test/official-decision",
      "2025 ABCA 12",
      "ABCA",
    );
    expect(
      buildA2AJDocumentPinpointUrl(
        official,
        { kind: "paragraph", label: "par12" },
        structureNative().documentText(official.native),
        [],
      ),
    ).toBe("https://example.test/official-decision");
    expect(
      buildA2AJDocumentPinpointUrl(
        document,
        { kind: "paragraph", label: "par81" },
        text,
        ["counter-speech remains a central consideration"],
      ),
    ).toContain("https://law.a2aj.ca/document?citation=2023+SCC+14&doc_type=cases#:~:text=");
  });

  it("keeps an unproved repeated BC passage on the publisher", async () => {
    const passage = "the repeated proposition governs this unusual legal dispute";
    const text = [
      `First context says ${passage} before its distinct ending.`,
      `Second context says ${passage} before another distinct ending.`,
    ].join("\n");
    const document = await nativeDocument(
      text,
      "https://www.bccourts.ca/Jdb-txt/CA/99/01/2099BCCA0001.htm",
      "2099 BCCA 1",
      "BCCA",
    );

    const result = buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par1" },
      text.split("\n")[0]!,
      [passage],
    )!;

    expect(result).toContain("https://www.bccourts.ca/");
  });

  it("does not route BC passages from legal vocabulary alone", async () => {
    const legalPassage =
      "section 12 of the Example Act controls this distinct application today";
    const ordinaryPassage =
      "this distinct proposition controls the unusual application before us today";
    const text = `${legalPassage}. ${ordinaryPassage}.`;
    const document = await nativeDocument(
      text,
      "https://www.bccourts.ca/Jdb-txt/CA/99/02/2099BCCA0002.htm",
      "2099 BCCA 2",
      "BCCA",
    );

    expect(buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par1" },
      text,
      [legalPassage],
    )).toContain("https://www.bccourts.ca/");
    expect(buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par1" },
      text,
      [ordinaryPassage],
    )).toContain("https://www.bccourts.ca/");
  });

  it("routes only proved no-oracle provider-plan signatures", () => {
    const plan = (overrides: Partial<NativeTextFragmentPlan> = {}): NativeTextFragmentPlan => ({
      directives: ["text=Example%20Act"],
      sourceWordIntervals: [{
        quoteIndex: 0, start: 10, end: 30, firstWord: 0, lastWord: 1,
      }],
      paintQuotes: ["Example Act"],
      sourceSafeComplete: true,
      paintedWords: 2,
      ...overrides,
    });

    expect(shouldUseA2AJWebFallback(
      "laws",
      "https://www.ontario.ca/laws/statute/example",
      plan(),
      "The unique Example—Act controls.",
    )).toBe(true);
    expect(shouldUseA2AJWebFallback(
      "laws",
      "https://www.ontario.ca/laws/statute/example",
      plan(),
      "Example Act appears here. Example Act appears again.",
    )).toBe(false);
    expect(shouldUseA2AJWebFallback(
      "laws",
      "https://publications.saskatchewan.ca/example.pdf",
      plan({ sourceWordIntervals: [{
        quoteIndex: 0, start: 200_010, end: 200_030, firstWord: 0, lastWord: 1,
      }] }),
      "Example Act. Example Act.",
    )).toBe(false);
    expect(shouldUseA2AJWebFallback(
      "laws",
      "https://www.justice.gov.nt.ca/en/files/legislation/example/example.a.pdf",
      plan({ sourceWordIntervals: [{
        quoteIndex: 0, start: 1_010, end: 1_030, firstWord: 0, lastWord: 1,
      }] }),
      "The unique Example Act controls.",
    )).toBe(true);
    expect(shouldUseA2AJWebFallback(
      "laws",
      "https://www.justice.gov.nt.ca/en/files/legislation/example/example.r1.pdf",
      plan({
        directives: ["text=alpha", "text=beta", "text=gamma", "text=delta"],
        sourceWordIntervals: [
          { quoteIndex: 0, start: 1_001, end: 1_002, firstWord: 0, lastWord: 0 },
          { quoteIndex: 0, start: 1_003, end: 1_004, firstWord: 1, lastWord: 1 },
          { quoteIndex: 0, start: 1_005, end: 1_006, firstWord: 2, lastWord: 2 },
          { quoteIndex: 0, start: 1_007, end: 1_008, firstWord: 3, lastWord: 3 },
        ],
        paintQuotes: ["alpha", "beta", "gamma", "delta"],
      }),
      "alpha beta gamma delta",
    )).toBe(true);
  });

  it("keeps CanLII PDF page links on the PDF", async () => {
    const text = "The PDF page contains a distinctive reporter proposition.";
    const document = await nativeDocument(
      text,
      "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.pdf",
    );
    const result = buildA2AJDocumentPinpointUrl(
      document,
      { kind: "page", label: "page19" },
      text,
      ["distinctive reporter proposition"],
    )!;

    expect(result).toContain(".pdf#page=19:~:text=");
  });

  it("keeps Decisia anchors except for the proved short Lexum fallback family", async () => {
    const text = `${"Background context. ".repeat(70)
      }[42] The appellate court stated the distinctive controlling principle.`;
    for (const [url, dataset, citation] of [
      [
        "https://coadecisions.ontariocourts.ca/coa/coa/en/item/22684/index.do?foo=bar",
        "ONCA",
        "2026 ONCA 42",
      ],
      [
        "https://decisions.fca-caf.gc.ca/fca-caf/decisions/en/item/522310/index.do",
        "FCA",
        "2026 FCA 42",
      ],
      [
        "https://decisia.lexum.com/nsc/nsca/en/item/523504/index.do",
        "NSCA",
        "2026 NSCA 42",
      ],
    ]) {
      const document = await nativeDocument(text, url, citation, dataset);
      const result = buildA2AJDocumentPinpointUrl(
        document,
        { kind: "paragraph", label: "par42" },
        text,
        ["distinctive controlling principle"],
      )!;
      if (new URL(url).hostname === "decisia.lexum.com") {
        expect(result).toContain("https://law.a2aj.ca/document?");
      } else {
        expect(result).toContain("iframe=true");
        expect(result).toContain("site_preference=mobile");
        expect(result).toContain("#par42:~:text=");
        expect(result).toContain(new URL(url).hostname);
        expect(result).not.toContain("canlii.org");
      }
    }
  });

  it("does not swap official BC court pages while building fragments", async () => {
    const text =
      "[42] The court stated a distinctive unanchored proposition in this passage.";
    const url =
      "https://www.bccourts.ca/jdb-txt/ca/26/03/2026BCCA0310.htm";
    const quote = "distinctive unanchored proposition";
    const document = await nativeDocument(text, url, "2026 BCCA 310", "BCCA");
    const result = buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par42" },
      text,
      [quote],
    )!;

    expect(result).toContain(`${url}#:~:text=`);
    expect(result).not.toContain("#par42");
    expect(result).not.toContain("canlii.org");
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
      "Delay in seeking child support can",
      "apply.",
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
      "The court",
      "circumstances.",
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
      "5",
      "orders.",
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
      "The",
      "if",
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
      "In making",
      "guidelines.",
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
      "A second",
      "Summary",
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
      "retroactively",
      "provisions.",
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

});
