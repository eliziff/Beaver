import { describe, expect, it } from "vitest";
import {
  classifyLegalMarkdown,
  deriveOriginalPdfCandidates,
  tokenizeLegalInline,
} from "../legalSourcePresentation";

function withoutInline(
  blocks: ReturnType<typeof classifyLegalMarkdown>,
) {
  return blocks.map(({ inline: _inline, ...block }) => block);
}

describe("legal source Markdown presentation", () => {
  it("ports the ToA heading and nested legislative provision hierarchy", () => {
    const blocks = classifyLegalMarkdown(
      "# Protection of Public Participation Act\n\n" +
        "### No amendments unless permitted\n\n" +
        "**6** **Unless** the court orders otherwise\n\n" +
        "(a) first *condition*\n\n" +
        "(i) nested `condition`",
    );

    expect(withoutInline(blocks)).toEqual([
      {
        kind: "heading",
        text: "Protection of Public Participation Act",
        level: 2,
      },
      {
        kind: "heading",
        text: "No amendments unless permitted",
        level: 3,
      },
      {
        kind: "provision",
        text: "6 Unless the court orders otherwise",
        label: "6",
        depth: 1,
      },
      {
        kind: "provision",
        text: "(a) first condition",
        label: "(a)",
        depth: 3,
      },
      {
        kind: "provision",
        text: "(i) nested condition",
        label: "(i)",
        depth: 4,
      },
    ]);
  });

  it("classifies lists, blockquotes, headings, and wrapped paragraphs as plain text", () => {
    const blocks = classifyLegalMarkdown(
      "## Analysis\n" +
        "1. **First** factor\n" +
        "  - [Second factor](https://example.test/source)\n" +
        "    * Third _factor_\n" +
        "> A *quoted* proposition\n" +
        "> continued with `authority`\n\n" +
        "A plain paragraph wrapped\nacross source lines.",
    );

    expect(withoutInline(blocks)).toEqual([
      { kind: "heading", text: "Analysis", level: 2 },
      {
        kind: "list-item",
        text: "First factor",
        marker: "1.",
        ordered: true,
        depth: 0,
      },
      {
        kind: "list-item",
        text: "Second factor",
        marker: "-",
        ordered: false,
        depth: 1,
      },
      {
        kind: "list-item",
        text: "Third factor",
        marker: "*",
        ordered: false,
        depth: 2,
      },
      {
        kind: "blockquote",
        text: "A quoted proposition continued with authority",
        depth: 0,
      },
      {
        kind: "paragraph",
        text: "A plain paragraph wrapped across source lines.",
        depth: 0,
      },
    ]);
    expect(blocks.map(({ text }) => text).join(" ")).not.toMatch(
      /(?:\*\*|###|`|\]\()/u,
    );
  });

  it("retains the conservative legal heading-prefix and common-heading rules", () => {
    expect(
      withoutInline(
        classifyLegalMarkdown(
          "II. Standard of Review\n\nAnalysis\n\nOrdinary sentence.",
        ),
      ),
    ).toEqual([
      {
        kind: "heading",
        text: "II. Standard of Review",
        level: 2,
      },
      { kind: "heading", text: "Analysis", level: 2 },
      { kind: "paragraph", text: "Ordinary sentence.", depth: 0 },
    ]);
  });

  it("keeps court front matter out of list and provision semantics", () => {
    expect(
      withoutInline(
        classifyLegalMarkdown(
          "SUPREME COURT OF CANADA\n\n" +
            "2024 SCC 26\n\n" +
            "- and -",
        ),
      ),
    ).toEqual([
      {
        kind: "heading",
        text: "SUPREME COURT OF CANADA",
        level: 2,
      },
      { kind: "paragraph", text: "2024 SCC 26", depth: 0 },
      { kind: "paragraph", text: "- and -", depth: 0 },
    ]);
  });

  it("tokenizes emphasis and safe inline semantics without executable HTML", () => {
    expect(
      tokenizeLegalInline(
        "A *legal* **rule**, `term`, [source](https://example.test/case)" +
          " and [pinpoint](#par42) H<sub>2</sub>O<sup>2</sup> " +
          "<em>ratio</em> <strong>holding</strong> " +
          "[unsafe](javascript:alert(1)).",
      ),
    ).toEqual([
      { kind: "text", text: "A " },
      { kind: "em", text: "legal" },
      { kind: "text", text: " " },
      { kind: "strong", text: "rule" },
      { kind: "text", text: ", " },
      { kind: "code", text: "term" },
      { kind: "text", text: ", " },
      {
        kind: "link",
        text: "source",
        href: "https://example.test/case",
      },
      { kind: "text", text: " and " },
      { kind: "link", text: "pinpoint", href: "#par42" },
      { kind: "text", text: " H" },
      { kind: "sub", text: "2" },
      { kind: "text", text: "O" },
      { kind: "sup", text: "2" },
      { kind: "text", text: " " },
      { kind: "em", text: "ratio" },
      { kind: "text", text: " " },
      { kind: "strong", text: "holding" },
      { kind: "text", text: " unsafe)." },
    ]);
    expect(classifyLegalMarkdown("*Rendered emphasis*.")[0].inline).toContainEqual(
      { kind: "em", text: "Rendered emphasis" },
    );
    expect(
      classifyLegalMarkdown(
        "**34(1)(a)** A nested statutory paragraph.",
      )[0],
    ).toMatchObject({
      kind: "provision",
      label: "34(1)(a)",
      text: "34(1)(a) A nested statutory paragraph.",
    });
  });
});

describe("original PDF candidate derivation", () => {
  it("derives the native Decisia document URL ahead of other evidence", () => {
    const candidates = deriveOriginalPdfCandidates({
      canonicalUrl:
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19911/index.do" +
        "?iframe=true#par42",
      upstreamLinks: [
        {
          url: "/downloads/reporter-copy.pdf",
          label: "Full text PDF",
          mediaType: "application/pdf",
        },
      ],
    });

    expect(candidates[0]).toMatchObject({
      url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/19911/1/document.do",
      source: "decisia",
    });
    expect(candidates[0].reasons).toContain("document-endpoint");
    expect(candidates[0].reasons).toContain("same-origin");
  });

  it("ports the ToA PDF-link signals and ranks normalized metadata before markup", () => {
    const candidates = deriveOriginalPdfCandidates({
      canonicalUrl: "https://law.example.test/case/42",
      upstreamLinks: [
        {
          url: "/api/document?id=42",
          label: "Original",
          mediaType: "application/pdf; charset=binary",
        },
      ],
      markup: `
        <a href="/ignore">Read HTML</a>
        <a href="/files/judgment.pdf">PDF</a>
        <a href="/download?id=42">Download</a>
        <a href="https://archive.example.test/judgment.pdf">Full text PDF</a>
        <a href="javascript:alert(1)">Download PDF</a>
      `,
    });

    expect(candidates.map(({ url }) => url)).toEqual([
      "https://law.example.test/api/document?id=42",
      "https://archive.example.test/judgment.pdf",
      "https://law.example.test/files/judgment.pdf",
      "https://law.example.test/download?id=42",
    ]);
    expect(candidates[0]).toMatchObject({
      source: "metadata",
      score: 115,
    });
    expect(candidates[0].reasons).toContain("pdf-media-type");
    expect(candidates.at(-1)?.score).toBe(50);
  });

  it("deduplicates links using their strongest provenance and rejects unsafe URLs", () => {
    const candidates = deriveOriginalPdfCandidates({
      canonicalUrl: "https://law.example.test/case/42",
      upstreamLinks: [
        {
          url: "/judgment.pdf",
          label: "Official PDF",
        },
        {
          url: "data:application/pdf;base64,AAAA",
          label: "PDF",
        },
        {
          url: "https://user:password@law.example.test/private.pdf",
          label: "PDF",
        },
      ],
      markup:
        '<a href="/judgment.pdf">Download PDF</a>' +
        '<a href="file:///tmp/judgment.pdf">PDF</a>',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: "https://law.example.test/judgment.pdf",
      source: "metadata",
      score: 145,
    });
    expect(candidates[0].reasons).toEqual(
      expect.arrayContaining([
        "pdf-extension",
        "same-origin",
        "explicit-pdf-label",
      ]),
    );
  });

  it("returns no candidate for an invalid canonical source", () => {
    expect(
      deriveOriginalPdfCandidates({
        canonicalUrl: "file:///tmp/landing.html",
        markup: '<a href="https://example.test/document.pdf">PDF</a>',
      }),
    ).toEqual([]);
  });
});
