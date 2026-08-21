import { describe, expect, it } from "vitest";
import type { A2AJLocatorLookup } from "../legalSources/a2aj";
import {
  buildA2AJPinpointUrl,
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

  it("allows same-origin viewer paths and rejects unsafe relative URLs", () => {
    const evidence = {
      url: "/single-documents/doc-1/file?rendition=pdf&version_id=version-1#page=1",
      blockText: "First exact passage. A second exact passage.",
      documentText: "First exact passage. A second exact passage.",
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

  it("builds A2AJ fragments only on the retrieved provider URL", () => {
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
      "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do?iframe=true&site_preference=mobile#par81",
    );
    expect(buildA2AJPinpointUrl({ ...lookup, url: null }, [], text)).toBeNull();
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
    ).toBe("https://example.test/official-decision");
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
      const lookup = lookupFixture({ text, dataset, citation, url });
      const result = buildA2AJPinpointUrl(
        lookup,
        ["distinctive controlling principle"],
        text,
      )!;
      expect(result).toContain("iframe=true");
      expect(result).toContain("site_preference=mobile");
      expect(result).toContain("#par42:~:text=");
      expect(result).toContain(new URL(url).hostname);
      expect(result).not.toContain("canlii.org");
    }
  });

  it("does not swap official BC court pages while building fragments", () => {
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

    expect(result).toContain(`${url}#:~:text=`);
    expect(result).not.toContain("#par42");
    expect(result).not.toContain("canlii.org");
  });

  it("pairs a long passage into a verified range without early-match starts", () => {
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
        documentText: text,
      },
      [quote],
    )!;
    const directive = result.split(":~:text=")[1];

    // A whole-quote target this long is one punctuation drift away from
    // dead. The range's short boundaries are each verified against the full
    // document, and the start boundary keeps its disambiguating continuation
    // ("...support CAN") - the bare prefix also opens the earlier paragraph.
    const [head, tail] = directive.split(",").map(decodeURIComponent);
    expect(head).toBe("Delay in seeking child support can");
    expect(tail).toBe("be decided arbitrarily not to apply");
  });

  it("never carries A2AJ pin-range artifacts into fragment targets", () => {
    const passage =
      "The court must ensure that the quantum of a retroactive award fits the circumstances.";
    const blockText = `${passage} [99-135]`;
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2311/index.do",
        anchor: "par135",
        blockText,
        documentText: blockText,
      },
      [blockText],
    )!;

    // The bracketed range is citation presentation appended to the receipt
    // span; it never appears on the page, so a target containing it can
    // only fail.
    expect(decodeURIComponent(result.split(":~:text=")[1])).toBe(passage);
  });

  it("starts fragment targets after margin numbers and provision labels", () => {
    const decisia = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2311/index.do",
        anchor: "par5",
        blockText:
          "5 Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders.",
        documentText:
          "5 Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders.",
      },
      [
        "5 Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders.",
      ],
    )!;
    expect(
      decodeURIComponent(decisia.split(":~:text=")[1]),
    ).toBe(
      "Against this backdrop, it becomes clear that retroactive awards cannot simply be regarded as exceptional orders.",
    );

    const kingsPrinter =
      "https://kings-printer.alberta.ca/1266.cfm?page=F04P5.cfm&leg_type=Acts&isbncln=9780779854820&display=html";
    const subsection = buildLegalSourcePinpointUrl(
      {
        url: kingsPrinter,
        blockText: "(2) The court may make a child support order only if",
        documentText: "(2) The court may make a child support order only if",
      },
      ["(2) The court may make a child support order only if"],
    )!;
    expect(decodeURIComponent(subsection.split(":~:text=")[1])).toBe(
      "The court may make a child support order only if",
    );

    const section = buildLegalSourcePinpointUrl(
      {
        url: kingsPrinter,
        blockText:
          "51 (1) In making a child support order, the court shall do so in accordance with the prescribed guidelines.",
        documentText:
          "51 (1) In making a child support order, the court shall do so in accordance with the prescribed guidelines.",
      },
      [
        "51 (1) In making a child support order, the court shall do so in accordance with the prescribed guidelines.",
      ],
    )!;
    expect(decodeURIComponent(section.split(":~:text=")[1])).toBe(
      "In making a child support order, the court shall do so in accordance with the prescribed guidelines.",
    );
  });

  it("ranges across source lines instead of emitting impossible targets", () => {
    const para =
      "[130] A second way courts can affect the quantum of retroactive awards is by altering the time period that the award captures while keeping fairness in view.";
    const blockText = `${para}\n5.5 Summary`;
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html",
        anchor: "par130",
        blockText,
        documentText: `${blockText}\n[131] A later paragraph continues with further distinct reasoning.`,
      },
      [blockText],
    )!;
    const raw = result.split(":~:text=")[1];

    // A passage crossing a source line break cannot sit inside one publisher
    // block either: the honest fragment is a start,end range whose each half
    // stays within one block.
    const [head, tail] = raw.split(",").map(decodeURIComponent);
    expect(head).toBe("A second way courts can affect");
    expect(tail).toBe("Summary");
    expect(raw).not.toMatch(/%0A/iu);
  });

  it("falls back to the anchor when a cross-line passage cannot be verified", () => {
    const para =
      "An unverifiable cross-line passage repeats twice in the judgment with no distinguishing context anywhere.";
    const blockText = `${para}\nAppendix`;
    const url = "https://example.test/decision";
    expect(
      buildLegalSourcePinpointUrl(
        {
          url,
          anchor: "par7",
          blockText,
          documentText: `${blockText}\n${blockText}`,
        },
        [blockText],
      ),
    ).toBe(`${url}#par7`);
  });
});
