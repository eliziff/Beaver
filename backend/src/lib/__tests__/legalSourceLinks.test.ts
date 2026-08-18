import { describe, expect, it } from "vitest";
import type { A2AJLocatorLookup } from "../a2aj";
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

});
