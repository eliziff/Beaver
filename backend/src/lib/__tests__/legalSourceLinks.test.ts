import { describe, expect, it } from "vitest";
import type { A2AJCompiledDocument } from "../legalSources/a2aj";
import {
  buildA2AJDocumentPinpointUrl,
  buildLegalSourcePinpointUrl,
} from "../legalSourceLinks";
import { deriveDocumentNative, documentTextNative } from "../structureNative";

async function nativeDocument(
  text: string,
  url = "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html",
  citation = "2099 SCC 1",
  dataset = "SCC",
): Promise<A2AJCompiledDocument> {
  const docType = url.includes("/laws/") ? "laws" as const : "cases" as const;
  const native = await deriveDocumentNative({
    kind: "a2aj",
    input: { citation, source_kind: docType, text, dataset, url },
  });
  return {
    docType,
    dataset,
    citation,
    alternateCitation: null,
    name: "Example v. Example",
    date: null,
    url,
    language: "en",
    upstreamLicense: null,
    native,
  };
}

describe("verified legal-source links", () => {
  it("treats source line wrapping as whitespace when proving uniqueness", async () => {
    const text = "A phrase split across\na source line remains one rendered passage.";
    const document = await nativeDocument(text);
    const result = buildLegalSourcePinpointUrl({
      url: document.url!,
      blockText: "A phrase split across a source line remains one rendered passage.",
      documentText: document.native,
    }, ["phrase split across a source line"]);

    expect(result).toContain(":~:text=phrase%20split%20across%20a%20source%20line");
  });

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

  it("builds an atomic, encoded multi-text directive and deduplicates quotes", async () => {
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
    expect(result).toContain("self%2Dregulating%20%26%20independent");
    expect(result).toContain("frivolous%2C%20vexatious");
    expect(
      buildA2AJDocumentPinpointUrl(
        document,
        { kind: "section", label: "sec6" },
        text,
        ["self-regulating & independent profession", "not present in source"],
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

  it("falls back to the structural anchor when the target is ambiguous", async () => {
    const sentence =
      "the safety of the community would not be endangered by the offender serving the sentence";
    const line = `In our respectful view, ${sentence}, and nothing more.`;
    const document = await nativeDocument(`${line}\n${line}`);

    expect(buildA2AJDocumentPinpointUrl(
      document,
      { kind: "paragraph", label: "par42" },
      line,
      [sentence],
    )).toBe(
      "https://www.canlii.org/en/ca/scc/doc/2099/2099scc1/2099scc1.html#par42",
    );
  });

  it("rewrites Decisia shell URLs to the inline document view", async () => {
    const text =
      "The court described the motiveless act as unusual in all the circumstances.";
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

  it("builds A2AJ fragments only on the retrieved provider URL", async () => {
    const text =
      "[81] In section 2(b) jurisprudence, counter-speech remains a central consideration.";
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
        documentTextNative(official.native),
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
    ).toContain(
      "decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do?iframe=true&site_preference=mobile#par81:~:text=",
    );
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

  it("uses native paragraph anchors on every Decisia deployment", async () => {
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
      const document = await nativeDocument(text, url, citation, dataset);
      const result = buildA2AJDocumentPinpointUrl(
        document,
        { kind: "paragraph", label: "par42" },
        text,
        ["distinctive controlling principle"],
      )!;
      expect(result).toContain("iframe=true");
      expect(result).toContain("site_preference=mobile");
      expect(result).toContain("#par42:~:text=");
      expect(result).toContain(new URL(url).hostname);
      expect(result).not.toContain("canlii.org");
    }
  });

  it("does not swap official BC court pages while building fragments", async () => {
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

  it("emits a citation-padded variant beside the plain spelling", () => {
    const passage =
      "This appeal centres on the appropriate framework for determining applications to retroactively decrease child support arrears under s. 17 of the Divorce Act and related provisions.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18909/index.do",
        anchor: "par1",
        blockText: passage,
        documentText: passage,
      },
      [
        "retroactively decrease child support arrears under s. 17 of the Divorce Act and related provisions",
      ],
    )!;

    // The quote continues past "s. 17", which Decisia renders as
    // "s.<NBSP>17<NBSP> of". Chromium never collapses that separator run,
    // so only the padded spelling can match there - while plain pages only
    // match the primary. Two directives, one logical highlight.
    expect(result.match(/text=/gu)).toHaveLength(2);
    const [plain, padded] = result
      .split(":~:text=")[1]
      .split("&")
      .map((directive) => decodeURIComponent(directive.replace(/^text=/u, "")));
    expect(plain).toContain("arrears under s. 17 of");
    expect(padded!).toContain("arrears under s.\u00A017\u00A0 of");
  });

  it("keeps single-directive output when no citation cluster is present", () => {
    const passage =
      "The amount of child support payable varies based on the payor income and often fluctuates.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18909/index.do",
        anchor: "par1",
        blockText: passage,
        documentText: passage,
      },
      ["child support payable varies based on the payor income"],
    )!;
    expect(result.match(/text=/gu)).toHaveLength(1);
  });

  it("targets the Competition Tribunal PDF instead of its empty HTML shell", () => {
    const passage = "The Tribunal considered the scope of its exclusive jurisdiction.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/464444/index.do",
        anchor: "par22",
        blockText: passage,
        documentText: passage,
      },
      [passage],
    )!;

    expect(result).toMatch(
      /^https:\/\/decisions\.ct-tc\.gc\.ca\/ct-tc\/cdo\/en\/464444\/1\/document\.do#:~:text=/u,
    );
  });

  it("drops HTML paragraph anchors from resolved PDF documents", () => {
    const passage = "The Applicant relied heavily on the previous decision.";
    const result = buildLegalSourcePinpointUrl(
      {
        url: "https://decisia.lexum.com/nsc/nssc/en/459053/1/document.do",
        anchor: "par17",
        blockText: passage,
        documentText: passage,
      },
      [passage],
    )!;
    expect(result).toMatch(/\/document\.do#:~:text=/u);
    expect(result).not.toContain("#par17");
  });

});
