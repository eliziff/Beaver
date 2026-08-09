import { describe, expect, it } from "vitest";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import {
  addA2AJInlineCitations,
  addA2AJInlineLinks,
  a2ajInlineLinkSnapshot,
  buildA2AJPinpointUrl,
  buildCourtlistenerCitationPinpointUrl,
  buildLegalSourceMultiPassageUrl,
  buildLegalSourcePinpointUrl,
} from "../legalSourceLinks";

function lookupFixture({
  text,
  url = "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
  citation = "2099 SCC 1",
  kind = "paragraph",
  locator = "para 42",
  label = "par42",
  dataset = "SCC",
}: {
  text: string;
  url?: string;
  citation?: string;
  kind?: A2AJLocatorLookup["requested"]["kind"];
  locator?: string;
  label?: string;
  dataset?: string;
}): A2AJLocatorLookup {
  return {
    status: "found",
    citation,
    alternateCitation: null,
    name: "Example v. Example",
    dataset,
    url,
    language: "en",
    requested: { kind, locator, label },
    matches: [label],
    block: { kind, label, start: 0, end: text.length, text },
    before: [],
    after: [],
    structure: {
      status: "usable",
      source: "flat_text",
      counts: {
        paragraph: kind === "paragraph" ? 1 : 0,
        page: kind === "page" ? 1 : 0,
        section: kind === "section" ? 1 : 0,
      },
    },
    sourceMethod: "structure_index",
  };
}

describe("verified legal-source links", () => {
  it("uses BCLaws HTML section anchors", () => {
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/00_11025_00_multi/xml",
        anchor: "sec19.15",
        blockText: "19.15 (1) An arbitrator may correct an award on application.",
      },
      ["An arbitrator may correct an award on application."],
    );

    expect(result).toContain("00_11025_00_multi#section19.15:~:text=");
  });

  it("uses the Justice Laws public page instead of its raw XML feed", () => {
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://laws-lois.justice.gc.ca/eng/XML/SOR-97-175.xml",
        blockText: "The applicable table is determined under these Guidelines.",
      },
      ["The applicable table is determined under these Guidelines."],
    );

    expect(result).toContain(
      "https://laws-lois.justice.gc.ca/eng/regulations/SOR-97-175/FullText.html#:~:text=",
    );
    expect(result).not.toContain("/XML/");
  });

  it("keeps paragraph markers out of CanLII text targets", () => {
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/bc/bcsc/doc/2024/2024bcsc2224/2024bcsc2224.html",
        anchor: "par38",
        blockText: "[38] I will note that fentanyl and some other controlled substances are inherently toxic, whether in the control of the accused or not.",
      },
      ["[38] I will note that fentanyl and some other controlled substances are inherently toxic, whether in the control of the accused or not."],
    );

    expect(result).toContain("#par38:~:text=I%20will%20note");
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
  ] as const)("anchors a %s lookup", (kind, locator, label, url, anchor) => {
    const text =
      "The distinctive source words establish this proposition conclusively.";
    const lookup = lookupFixture({ text, kind, locator, label, url });

    const result = buildA2AJPinpointUrl(
      lookup,
      ["distinctive source words establish this proposition"],
      text,
    );

    expect(result).toContain(`${anchor}:~:text=`);
  });

  it("builds an atomic, encoded multi-text directive and deduplicates quotes", () => {
    const text =
      "6 A self-regulating & independent profession acts in the public interest. " +
      "A frivolous, vexatious request may be denied.";
    const lookup = lookupFixture({
      text,
      kind: "section",
      locator: "s. 6",
      label: "sec6",
      url: "https://www.canlii.org/en/ca/laws/stat/example/latest/example.html",
    });
    const result = buildA2AJPinpointUrl(
      lookup,
      [
        "self-regulating & independent profession",
        "frivolous, vexatious request",
        "self-regulating & independent profession",
      ],
      text,
    )!;

    expect(result.match(/text=/gu)).toHaveLength(2);
    expect(result).toContain("&text=");
    expect(result).toContain("self%2Dregulating%20%26%20independent");
    expect(result).toContain("frivolous%2C%20vexatious");
    expect(
      buildA2AJPinpointUrl(
        lookup,
        ["self-regulating & independent profession", "not present in source"],
        text,
      ),
    ).toBe(
      "https://www.canlii.org/en/ca/laws/stat/example/latest/example.html#sec6",
    );
  });

  it("links a quote carrying an editorial alteration", () => {
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
      documentText: blockText,
    };
    const result = buildLegalSourcePinpointUrl(evidence, [
      "[T]he duty of care applies to every occupier of the premises.",
    ])!;

    expect(result).toContain(":~:text=");
    expect(result).toContain("Parliament%20said%20the%20following.-,");
    // A quote that is genuinely ambiguous still declines to link.
    expect(
      buildLegalSourcePinpointUrl(evidence, ["of the premises"]),
    ).toBe("https://example.test/decision");
  });

  it("keeps identical language at distinct verified pinpoints", () => {
    const first =
      "Alpha context explains why the same rule applies uniquely here. End alpha.";
    const second =
      "Beta context explains why the same rule applies uniquely here. End beta.";
    const documentText = `${first}\n${second}`;
    const result = buildLegalSourceMultiPassageUrl(
      "https://example.test/decision",
      [
        {
          key: "para-1",
          blockText: first,
          documentText,
          quotes: ["the same rule applies uniquely here"],
        },
        {
          key: "para-2",
          blockText: second,
          documentText,
          quotes: ["the same rule applies uniquely here"],
        },
      ],
    )!;

    expect(result.match(/text=/gu)).toHaveLength(2);
    expect(result).toContain("Alpha%20context");
    expect(result).toContain("Beta%20context");
    expect(
      buildLegalSourceMultiPassageUrl("https://example.test/decision", [
        {
          key: "para-1",
          blockText: first,
          documentText,
          quotes: ["words absent from the source"],
        },
      ]),
    ).toBeNull();
  });

  it("allows same-origin viewer paths and rejects unsafe relative URLs", () => {
    const evidence = {
      url: "/single-documents/doc-1/display?version_id=version-1#page=1",
      blockText: "First exact passage. A second exact passage.",
      documentText: "First exact passage. A second exact passage.",
      pageScoped: true,
    };
    const result = buildLegalSourcePinpointUrl(evidence, [
      "First exact passage",
      "second exact passage",
    ]);

    expect(result).toContain(
      "/single-documents/doc-1/display?version_id=version-1#page=1:~:text=",
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

  it("falls back to the structural anchor when the target is ambiguous", () => {
    const sentence =
      "the safety of the community would not be endangered by the offender serving the sentence";
    const line = `In our respectful view, ${sentence}, and nothing more.`;
    const lookup = lookupFixture({ text: line });

    expect(buildA2AJPinpointUrl(lookup, [sentence], `${line}\n${line}`)).toBe(
      "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html#par42",
    );
  });

  it("rewrites Decisia shell URLs to the inline document view", () => {
    const text =
      "The court described the motiveless act as unusual in all the circumstances.";
    const lookup = lookupFixture({
      text,
      locator: "para 191",
      label: "par191",
      url:
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/21212/index.do" +
        "?foo=bar&iframe=false&site_preference=desktop",
    });
    const result = buildA2AJPinpointUrl(lookup, ["motiveless act"], text)!;

    // site_preference=mobile is load-bearing: without it the desktop
    // rendering locks the viewport on the text-fragment match and the page
    // cannot be scrolled.
    expect(result).toContain("foo=bar&iframe=true&site_preference=mobile");
    expect(result).toContain("#par191:~:text=");
    expect(result).toContain("motiveless%20act");
    expect(result).not.toContain("iframe=false");
    expect(result).not.toContain("site_preference=desktop");
    expect(result.match(/iframe=/gu)).toHaveLength(1);
  });

  it("keeps CanLII citation links distinct from SCC quote-highlight links", () => {
    const text =
      "[81] In section 2(b) jurisprudence, counter-speech remains a central consideration.";
    const lookup = lookupFixture({
      text,
      citation: "2023 SCC 14",
      locator: "para 81",
      label: "par81",
      url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do",
    });

    expect(buildA2AJPinpointUrl(lookup, [], text)).toBe(
      "https://www.canlii.org/en/ca/scc/doc/2023/2023scc14/2023scc14.html#par81",
    );
    expect(buildA2AJPinpointUrl({ ...lookup, url: null }, [], text)).toBe(
      "https://www.canlii.org/en/ca/scc/doc/2023/2023scc14/2023scc14.html#par81",
    );
    expect(
      buildA2AJPinpointUrl(
        lookupFixture({
          text: "[12] The Alberta court states the governing rule.",
          citation: "2025 ABCA 12",
          dataset: "ABCA",
          locator: "para 12",
          label: "par12",
          url: "https://example.test/official-decision",
        }),
        [],
        text,
      ),
    ).toBe(
      "https://www.canlii.org/en/ab/abca/doc/2025/2025abca12/2025abca12.html#par12",
    );
    expect(
      buildA2AJPinpointUrl(
        lookup,
        ["counter-speech remains a central consideration"],
        text,
      ),
    ).toContain(
      "decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do?iframe=true&site_preference=mobile#par81:~:text=",
    );
  });

  it("keeps CanLII PDF page links on the PDF", () => {
    const text = "The PDF page contains a distinctive reporter proposition.";
    const lookup = lookupFixture({
      text,
      kind: "page",
      locator: "page 19",
      label: "page19",
      url: "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.pdf",
    });
    const result = buildA2AJPinpointUrl(
      lookup,
      ["distinctive reporter proposition"],
      text,
    )!;

    expect(result).toContain(".pdf#page=19:~:text=");
  });

  it("uses native paragraph anchors on every Decisia deployment", () => {
    const text =
      "[42] The appellate court stated the distinctive controlling principle.";
    for (const url of [
      "https://coadecisions.ontariocourts.ca/coa/coa/en/item/22684/index.do?foo=bar",
      "https://decisions.fca-caf.gc.ca/fca-caf/decisions/en/item/522310/index.do",
      "https://decisia.lexum.com/nsc/nsca/en/item/523504/index.do",
    ]) {
      const lookup = lookupFixture({ text, dataset: "ONCA", url });
      const result = buildA2AJPinpointUrl(
        lookup,
        ["distinctive controlling principle"],
        text,
      )!;
      expect(result).toContain("iframe=true");
      expect(result).toContain("site_preference=mobile");
      expect(result).toContain("#par42:~:text=");
    }
  });

  it("uses CanLII anchors without fabricating them on BC court pages", () => {
    const text =
      "[42] The court stated a distinctive unanchored proposition in this passage.";
    const url =
      "https://www.bccourts.ca/jdb-txt/ca/26/03/2026BCCA0310.htm";
    const quote = "distinctive unanchored proposition";
    const official = buildLegalSourcePinpointUrl(
      { url, blockText: text, documentText: text },
      [quote],
    )!;
    expect(official).toContain("#:~:text=");
    expect(official).not.toContain("#par42");

    const lookup = lookupFixture({
      text,
      citation: "2026 BCCA 310",
      dataset: "BCCA",
      url,
    });
    const result = buildA2AJPinpointUrl(lookup, [quote], text)!;

    expect(result).toContain(
      "https://www.canlii.org/en/bc/bcca/doc/2026/2026bcca310/2026bcca310.html#par42:~:text=",
    );
  });

  it("replaces the latest chat's model URLs with verified inline citations", () => {
    const answer = [
      "- Hansman 2023 SCC 14 para 81",
      "  https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do#par81",
      "- Pointes 2020 SCC 22 para 28",
      "  https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18458/index.do#par28",
      "- Rooney 2024 BCCA 8 para 118",
      "  https://www.bccourts.ca/jdb-txt/ca/24/00/2024BCCA0008cor1.htm#para118",
      "- Marcellin 2024 ONCA 468 para 63",
      "  https://coadecisions.ontariocourts.ca/coa/coa/en/item/22455/index.do#:~:text=The%20threshold%20for%20qualified%20privilege%20is%20high",
      '  quote: "The threshold for qualified privilege is high."',
      "- 40 Days 2024 ONCA 599 para 74",
      "  https://coadecisions.ontariocourts.ca/coa/coa/en/item/22581/index.do#:~:text=Instead%2C%20the%20purpose%20of%20the%20impugned%20videos",
      '  quote: "Instead, the purpose of the impugned videos was to disrupt 40 Days’ operations."',
      "- Burjoski 2024 ONCA 811 para 77",
      "  https://coadecisions.ontariocourts.ca/coa/coa/en/item/22797/index.do#:~:text=Rather%2C%20the%20issue%20was%20whether%20the%20Board%20Chair",
      '  quote: "Rather, the issue was whether the Board Chair had a right to respond to the respondent, in the way that he chose, without the threat of civil liability."',
    ].join("\n");
    const lookups = [
      lookupFixture({
        text: "[81] In section 2(b) jurisprudence, counter-speech remains central.",
        citation: "2023 SCC 14",
        locator: "para 81",
        label: "par81",
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do",
      }),
      lookupFixture({
        text: "[28] The analysis at this stage turns on the statutory language.",
        citation: "2020 SCC 22",
        locator: "para 28",
        label: "par28",
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18458/index.do",
      }),
      lookupFixture({
        text:
          "[74] Instead, the purpose of the impugned videos was to disrupt 40 Days’ operations.",
        citation: "2024 ONCA 599",
        dataset: "ONCA",
        locator: "para 74",
        label: "par74",
        url: "https://coadecisions.ontariocourts.ca/coa/coa/en/item/22581/index.do",
      }),
      lookupFixture({
        text:
          "[77] Rather, the issue was whether the Board Chair had a right to respond to the respondent, in the way that he chose, without the threat of civil liability.",
        citation: "2024 ONCA 811",
        dataset: "ONCA",
        locator: "para 77",
        label: "par77",
        url: "https://coadecisions.ontariocourts.ca/coa/coa/en/item/22797/index.do",
      }),
    ];

    const result = addA2AJInlineCitations(answer, lookups);
    const urlFor = (citation: string) =>
      (result.citations.find(
        (item) =>
          (item as { citation?: string }).citation === citation,
      ) as { url?: string } | undefined)?.url;

    expect(result.text).not.toContain("http");
    expect(result.text).not.toContain("Sources:");
    expect(result.text).toMatch(/2023 SCC 14 para 81\[\d+\]/u);
    expect(result.text).toMatch(/2024 ONCA 468 para 63\[\d+\]/u);
    expect(urlFor("2023 SCC 14")).toBe(
      "https://www.canlii.org/en/ca/scc/doc/2023/2023scc14/2023scc14.html#par81",
    );
    expect(urlFor("2024 BCCA 8")).toBe(
      "https://www.canlii.org/en/bc/bcca/doc/2024/2024bcca8/2024bcca8.html#par118",
    );
    expect(urlFor("2024 ONCA 468")).toBe(
      "https://www.canlii.org/en/on/onca/doc/2024/2024onca468/2024onca468.html#par63",
    );
    expect(urlFor("2024 ONCA 599")).toContain("#par74:~:text=");
    expect(urlFor("2024 ONCA 811")).toContain("#par77:~:text=");
  });

  it("uses exact external links instead of source footnotes by default", () => {
    const quote = "The governing rule applies without qualification.";
    const result = addA2AJInlineLinks(
      `R v Example, 2099 SCC 1, at para. 42 — “${quote}”`,
      [
        lookupFixture({
          text: `[42] ${quote}`,
          url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
        }),
      ],
    );

    expect(result.text).toContain(
      "[2099 SCC 1, at para. 42](https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do?iframe=true&site_preference=mobile#par42:~:text=The%20governing%20rule%20applies%20without%20qualification.)",
    );
    expect(result.text).toContain(`“${quote}”`);
    expect(result.text).not.toContain(`“[${quote}]`);
    expect(result.text).not.toMatch(/\[\d+\]/u);
    expect(result.citations).toEqual([]);
  });

  it("puts same-paragraph quote omissions in one citation-pill URL", () => {
    const first = "The first controlling proposition applies in every case.";
    const second = "The second controlling proposition supplies the remedy.";
    const lookup = lookupFixture({
      text:
        `[42] ${first} Intervening analysis addresses a separate point. ` +
        second,
    });
    const result = addA2AJInlineLinks(
      `> “${first}”\n>\n> “${second}”\n\n— Example, 2099 SCC 1 at para. 42.`,
      [lookup],
    );

    expect(result.text.match(/\]\(https?:/gu)).toHaveLength(1);
    expect(result.text.match(/text=/gu)).toHaveLength(2);
    expect(result.text).toContain("&text=");
    expect(result.text).toContain(`> “${first}”`);
    expect(result.text).toContain(`> “${second}”`);
  });

  it("emits a linked streaming snapshot only when its pills change", () => {
    const answer = "See 2024 SCC 6 at para. 12.\n";
    const first = a2ajInlineLinkSnapshot(answer, [], [], "");

    expect(first?.text).toContain(
      "[2024 SCC 6 at para. 12](https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html#par12)",
    );
    expect(
      a2ajInlineLinkSnapshot(answer, [], [], first?.signature ?? ""),
    ).toBeNull();
  });

  it("links an ordinary case pinpoint directly to CanLII", () => {
    const result = addA2AJInlineLinks(
      "See 2024 SCC 6 at para. 12 [1]:\n\n> The governing test.",
      [],
    );

    expect(result).toEqual({
      text:
        "See [2024 SCC 6 at para. 12](https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html#par12):\n\n> The governing test.",
      citations: [],
    });
  });

  it("keeps a paragraph range on its start anchor when source text is unavailable", () => {
    const result = addA2AJInlineLinks(
      "The governing discussion is in 2024 SCC 6 at paras. 12\u201314, not the quoted text that follows.",
      [],
    );

    expect(result.text).toBe(
      "The governing discussion is in [2024 SCC 6 at paras. 12\u201314](https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html#par12), not the quoted text that follows.",
    );
    expect(result.text).not.toContain(
      "[2024 SCC 6](https://www.canlii.org",
    );
    expect(result.text).not.toContain(
      "[2024 SCC 6 at paras. 12](https://www.canlii.org",
    );
  });

  it("spans a paragraph range with one verified text fragment", () => {
    const text = [
      "[1] The opening paragraph provides a unique procedural history for this fictional appeal.",
      "[2] The range begins with a distinctive governing proposition that appears nowhere else in the judgment.",
      "[3] The middle paragraph applies that proposition to the unusual facts found at trial.",
      "[4] The range ends by stating a distinctive remedy and final consequence for the parties.\n(3) Applying the test\n(a) The following issue",
      "[5] The costs paragraph contains separate language about the allocation of appellate costs.",
      "[6] The disposition paragraph gives the remaining formal directions required by the court.",
    ].join("\n");
    const document: A2AJDocument = {
      dataset: "SCC",
      citation: "2099 SCC 1",
      alternateCitation: null,
      name: "Example v. Example",
      date: "2099-01-01",
      url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
      text,
      language: "en",
      upstreamLicense: null,
      structure: {
        status: "unavailable",
        source: "flat_text",
        counts: { paragraph: 0, page: 0, section: 0 },
      },
    };

    const result = addA2AJInlineLinks(
      "See 2099 SCC 1 at paras. 2–4.",
      [],
      [],
      [document],
    );

    expect(result.text).toContain(
      "[2099 SCC 1 at paras. 2–4](https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do?iframe=true&site_preference=mobile#par2:~:text=",
    );
    expect(result.text.match(/text=/gu)).toHaveLength(1);
    expect(result.text).toMatch(/#par2:~:text=[^)]+,[^)]+\)/u);
    expect(result.text).not.toContain("Applying");
  });

  it("normalizes a case-level SCC docket link to CanLII", () => {
    const result = addA2AJInlineLinks(
      "*Auer v. Auer*, [2024 SCC 36](https://www.scc-csc.ca/case-dossier/info/dock-regi-eng.aspx?cas=40397)",
      [],
    );

    expect(result).toEqual({
      text:
        "*Auer v. Auer*, [2024 SCC 36](https://www.canlii.org/en/ca/scc/doc/2024/2024scc36/2024scc36.html)",
      citations: [],
    });
  });

  it("replaces citation-shaped relative links instead of nesting Markdown", () => {
    const result = addA2AJInlineLinks(
      "[2024 SCC 36](2024 SCC 36); [2024 SCC 22](2024 SCC 22)",
      [],
    );

    expect(result.text).toBe(
      "[2024 SCC 36](https://www.canlii.org/en/ca/scc/doc/2024/2024scc36/2024scc36.html); " +
        "[2024 SCC 22](https://www.canlii.org/en/ca/scc/doc/2024/2024scc22/2024scc22.html)",
    );
  });

  it("turns a fetched case quote into one verified SCC highlight", () => {
    const quote = "The governing rule applies without qualification.";
    const text = [
      "[1] This opening paragraph contains enough substantive judicial language to establish the factual and procedural setting.",
      `[2] ${quote} The remainder of this paragraph explains the rule in sufficient detail for reliable structure detection.`,
      "[3] This paragraph applies the governing rule to the material facts found by the trial judge in this proceeding.",
      "[4] This paragraph addresses the competing submission and explains why it cannot alter the governing legal analysis.",
      "[5] This paragraph states the resulting disposition and the consequences that follow for each party to the appeal.",
      "[6] This concluding paragraph resolves costs and provides the remaining formal directions required by the judgment.",
    ].join("\n");
    const document: A2AJDocument = {
      dataset: "SCC",
      citation: "2099 SCC 1",
      alternateCitation: null,
      name: "R. v. Example",
      date: "2099-01-01",
      url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
      text,
      language: "en",
      upstreamLicense: null,
      structure: {
        status: "unavailable",
        source: "flat_text",
        counts: { paragraph: 0, page: 0, section: 0 },
      },
    };

    const result = addA2AJInlineLinks(
      `R. v. Example, 2099 SCC 1: “${quote}” (para. 2)`,
      [],
      [],
      [document],
    );

    expect(result.text).toContain(
      "[2099 SCC 1](https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do?iframe=true&site_preference=mobile#par2:~:text=The%20governing%20rule%20applies%20without%20qualification.)",
    );
    expect(result.text).toContain(`“${quote}”`);
    expect(result.text).not.toContain(`“[${quote}]`);
    expect(result.text).not.toContain("#par1");
    expect(result.text).not.toMatch(/\[\d+\]/u);
    expect(result.citations).toEqual([]);
  });

  it("adds one inline multi-text citation without copying source text", () => {
    const answer =
      "The court said “the duty is mandatory in these circumstances” and " +
      "later added “a distinct remedy is also available”.";
    const text =
      "[42] The court said the duty is mandatory in these circumstances. " +
      "It added that a distinct remedy is also available.";
    const lookup = lookupFixture({ text });

    const result = addA2AJInlineCitations(answer, [lookup]);
    const url = (result.citations[0] as { url: string }).url;

    expect(result.text).toContain("circumstances”[1]");
    expect(result.text).not.toContain("Source:");
    expect(url.match(/text=/gu)).toHaveLength(2);
    expect(url).toContain("&text=");
    expect(url).toContain("#par42:~:text=");
    expect(result.text).not.toContain(text);
  });

  it("attaches verified metadata to an adjacent marker emitted by the model", () => {
    const quote = "The distinctive controlling proposition applies.";
    const result = addA2AJInlineCitations(
      `The court said "${quote}" [1]`,
      [lookupFixture({ text: `[42] ${quote}` })],
    );

    expect(result.text.match(/\[1\]/gu)).toHaveLength(1);
    expect(result.citations).toEqual([
      expect.objectContaining({
        type: "citation_data",
        kind: "a2aj",
        ref: 1,
        citation: "2099 SCC 1",
      }),
    ]);
  });

  it("replaces a model citation for lookup evidence instead of duplicating it", () => {
    const quote = "The distinctive controlling proposition applies.";
    const lookup = lookupFixture({ text: `[42] ${quote}` });
    const result = addA2AJInlineCitations(
      `The court said "${quote}" [1]`,
      [lookup],
      [
        {
          type: "citation_data",
          kind: "a2aj",
          ref: 1,
          citation: "2099 SCC 1",
          name: null,
          dataset: null,
          url: "https://example.test/model-built-link",
          quotes: [{ quote: lookup.block!.text }],
        },
      ],
    );

    expect(result.text.match(/\[\d+\]/gu)).toEqual(["[1]"]);
    expect(result.citations).toEqual([
      expect.objectContaining({
        ref: 1,
        citation: "2099 SCC 1",
        quotes: [{ quote }],
      }),
    ]);
    expect((result.citations[0] as { url: string }).url).toContain(
      "#par42:~:text=The%20distinctive%20controlling%20proposition%20applies.",
    );
  });

  it("points neighbor-context quotes at the block that actually contains them", () => {
    const lookup = lookupFixture({
      text: "[42] The requested paragraph addresses a different issue.",
    });
    lookup.before = [
      {
        kind: "paragraph",
        label: "par41",
        start: 0,
        end: 79,
        text: "[41] The neighboring paragraph states the distinctive controlling rule.",
      },
    ];
    const quote =
      "neighboring paragraph states the distinctive controlling rule";
    const anonymous = addA2AJInlineCitations(
      `The court said "${quote}".`,
      [lookup],
    );

    expect(anonymous.text).toContain(`"${quote}"[1]`);
    expect((anonymous.citations[0] as { url: string }).url).toContain(
      "#par41:~:text=",
    );
    expect((anonymous.citations[0] as { url: string }).url).not.toContain(
      "#par42",
    );
  });

  it("uses verified range boundaries for long CanLII paragraphs", () => {
    const quote =
      "[41] The evidence also established that, because fentanyl can be inhaled and absorbed through the skin, it presents serious risks to anyone who handles it or is near to it. For this reason, the Centre of Forensic Sciences has implemented strict safety guidelines for handling fentanyl.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/on/onca/doc/2021/2021onca518/2021onca518.html",
        anchor: "par41",
        blockText: quote,
        documentText: quote,
      },
      [quote],
    );

    expect(result).toBe(
      "https://www.canlii.org/en/on/onca/doc/2021/2021onca518/2021onca518.html#par41:~:text=The%20evidence%20also%20established%20that,safety%20guidelines%20for%20handling%20fentanyl.",
    );
  });

  it("falls back to the trusted CourtListener case URL on a quote mismatch", () => {
    expect(
      buildCourtlistenerCitationPinpointUrl(
        {
          quotes: [{ opinionId: 7, quote: "not present in the opinion" }],
        },
        {
          url: "https://www.courtlistener.com/opinion/42/example/",
          opinions: [{ opinionId: 7, text: "The actual opinion text." }],
        },
      ),
    ).toBe("https://www.courtlistener.com/opinion/42/example/");
  });

});
