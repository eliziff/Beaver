import { describe, expect, it } from "vitest";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import {
  appendA2AJPinpointLinks,
  buildA2AJPinpointUrl,
  buildCourtlistenerCitationPinpointUrl,
  buildTnaPinpointUrl,
} from "../legalSourceLinks";
import { createCitation, parseCitations } from "../chat/citations";

function lookupFixture({
  text,
  url = "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
  kind = "paragraph",
  locator = "para 42",
  label = "par42",
  dataset = "SCC",
}: {
  text: string;
  url?: string;
  kind?: A2AJLocatorLookup["requested"]["kind"];
  locator?: string;
  label?: string;
  dataset?: string;
}): A2AJLocatorLookup {
  return {
    status: "found",
    citation: "2099 SCC 1",
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

  it("falls back to the structural anchor when the target is ambiguous", () => {
    const sentence =
      "the safety of the community would not be endangered by the offender serving the sentence";
    const line = `In our respectful view, ${sentence}, and nothing more.`;
    const lookup = lookupFixture({ text: line });

    expect(buildA2AJPinpointUrl(lookup, [sentence], `${line}\n${line}`)).toBe(
      "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html#par42",
    );
  });

  it("uses the SCC scrollable view without duplicate query settings", () => {
    const text =
      "The court described the motiveless act as unusual in all the circumstances.";
    const lookup = lookupFixture({
      text,
      locator: "para 191",
      label: "par191",
      url:
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/1705/index.do" +
        "?foo=bar&iframe=false&site_preference=desktop",
    });
    const result = buildA2AJPinpointUrl(lookup, ["motiveless act"], text)!;

    expect(result).toContain("foo=bar&iframe=true&site_preference=mobile");
    expect(result).toContain("#par191:~:text=");
    expect(result).toContain("motiveless%20act");
    expect(result).not.toContain("iframe=false");
    expect(result).not.toContain("site_preference=desktop");
    expect(result.match(/iframe=/gu)).toHaveLength(1);
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

  it("uses native Lexum paragraph anchors across A2AJ court datasets", () => {
    const text =
      "[42] The appellate court stated the distinctive controlling principle.";
    const lookup = lookupFixture({
      text,
      dataset: "ONCA",
      url: "https://www.canlii.invalid/decisions/onca/2026/540/document.do?foo=bar",
    });
    const result = buildA2AJPinpointUrl(
      lookup,
      ["distinctive controlling principle"],
      text,
    )!;

    expect(result).toContain(
      "?foo=bar&iframe=true&site_preference=mobile#par42:~:text=",
    );
  });

  it("does not fabricate paragraph anchors for BC-family decisions", () => {
    const text =
      "[42] The court stated a distinctive unanchored proposition in this passage.";
    const lookup = lookupFixture({
      text,
      dataset: "BCCA",
      url: "https://www.bccourts.ca/jdb-txt/ca/26/03/2026BCCA0310.htm",
    });
    const result = buildA2AJPinpointUrl(
      lookup,
      ["distinctive unanchored proposition"],
      text,
    )!;

    expect(result).toContain("#:~:text=");
    expect(result).not.toContain("#par42");
  });

  it("appends one automatic multi-text source link without copying source text", () => {
    const answer =
      "The court said “the duty is mandatory in these circumstances” and " +
      "later added “a distinct remedy is also available”.";
    const text =
      "[42] The court said the duty is mandatory in these circumstances. " +
      "It added that a distinct remedy is also available.";
    const lookup = lookupFixture({ text });

    const result = appendA2AJPinpointLinks(answer, [lookup]);

    expect(result.startsWith(answer)).toBe(true);
    expect(result.match(/text=/gu)).toHaveLength(2);
    expect(result).toContain("&text=");
    expect(result).toContain("#par42:~:text=");
    expect(result).toContain("Source: [2099 SCC 1, para. 42]");
    expect(result.slice(answer.length)).not.toContain(text);
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
    const [parsed] = parseCitations(
      `<CITATIONS>[{"ref":1,"source":"a2aj","citation":"2099 SCC 1",` +
        `"dataset":"SCC","quote":"${quote}"}]</CITATIONS>`,
    );

    const authenticated = createCitation(parsed, {}, undefined, [lookup]).url;
    const anonymous = appendA2AJPinpointLinks(`The court said "${quote}".`, [
      lookup,
    ]);

    expect(authenticated).toContain("#par41:~:text=");
    expect(anonymous).toContain("Source: [2099 SCC 1, para. 41]");
    expect(anonymous).toContain("#par41:~:text=");
    expect(anonymous).not.toContain("#par42");
  });

  it("replaces a model URL with the server-built trusted pinpoint URL", () => {
    const text =
      "The distinctive source words establish this proposition conclusively.";
    const lookup = lookupFixture({ text });
    const [parsed] = parseCitations(
      '<CITATIONS>[{"ref":1,"source":"a2aj","citation":"2099 SCC 1",' +
        '"dataset":"SCC","url":"https://untrusted.example/model-link",' +
        '"quote":"distinctive source words establish this proposition"}]</CITATIONS>',
    );
    const result = createCitation(parsed, {}, undefined, [lookup]);

    expect(result.url).toContain(
      "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html#par42:~:text=",
    );
    expect(result.url).not.toContain("untrusted.example");
  });

  it("uses a fetched-document URL only when server evidence verifies it", () => {
    const lookup = lookupFixture({
      text: "Paragraph 42 contains a different proposition entirely.",
    });
    const document: A2AJDocument = {
      dataset: "SCC",
      citation: "2099 SCC 1",
      alternateCitation: null,
      name: "Example v. Example",
      date: "2099-01-01",
      url: "https://example.test/full-case",
      text: "Paragraph 99 contains text from paragraph 99.",
      language: "en",
      upstreamLicense: null,
      structure: {
        status: "unavailable",
        source: "flat_text",
        counts: { paragraph: 0, page: 0, section: 0 },
      },
    };
    const [parsed] = parseCitations(
      '<CITATIONS>[{"ref":1,"source":"a2aj","citation":"2099 SCC 1",' +
        '"url":"https://example.test/full-case","quote":"text from paragraph 99"}]' +
        "</CITATIONS>",
    );

    expect(
      createCitation(parsed, {}, undefined, [lookup], [document]).url,
    ).toContain(
      "https://example.test/full-case#:~:text=text%20from%20paragraph%2099",
    );
    expect(createCitation(parsed, {}, undefined, [lookup]).url).toBeNull();
  });

  it("builds one atomic multi-text CourtListener link from cached opinions", () => {
    const text =
      "The court adopted the distinctive first proposition. " +
      "It then applied the separate second proposition.";
    const result = buildCourtlistenerCitationPinpointUrl(
      {
        quotes: [
          { opinionId: 7, quote: "distinctive first proposition" },
          { opinionId: 7, quote: "separate second proposition" },
        ],
      },
      {
        url: "https://www.courtlistener.com/opinion/42/example/",
        opinions: [{ opinionId: 7, text }],
      },
    )!;

    expect(result).toContain("#:~:text=");
    expect(result.match(/text=/gu)).toHaveLength(2);
    expect(result).toContain("&text=");
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

  it("uses TNA's native paragraph eId plus a verified text directive", () => {
    const paragraph =
      "The tribunal stated the distinctive jurisdictional principle.";
    const result = buildTnaPinpointUrl({
      url: "https://caselaw.nationalarchives.gov.uk/ewhc/kb/2026/1925",
      pinpoint: "para 24",
      paragraphText: paragraph,
      documentText: paragraph,
      quotes: ["distinctive jurisdictional principle"],
    });

    expect(result).toContain("#para_24:~:text=");
  });
});
