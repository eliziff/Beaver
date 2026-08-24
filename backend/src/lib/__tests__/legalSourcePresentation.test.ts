import { describe, expect, it } from "vitest";
import {
  deriveOriginalPdfCandidates,
  verifiedDecisiaPdf,
} from "../legalSourcePresentation";

describe("original PDF candidate derivation", () => {
  it("accepts the PDF anchor in the Decisia documents control", () => {
    const canonical =
      "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/530291/index.do";
    const markup = `<li class="documents"><a
      href="/fc-cf/decisions/en/530291/1/document.do">PDF</a></li>`;
    const candidates = deriveOriginalPdfCandidates({
      canonicalUrl: canonical,
      markup,
    });

    expect(verifiedDecisiaPdf(markup, canonical)).toEqual({
      url: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/530291/1/document.do",
      pdfOnly: false,
    });
    expect(candidates[0]).toMatchObject({
      url: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/530291/1/document.do",
      source: "markup",
    });
    expect(candidates[0].reasons).toContain("document-endpoint");
    expect(candidates[0].reasons).toContain("same-origin");
  });

  it("retains the publisher's explicit PDF-only evidence", () => {
    const canonical =
      "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/464621/index.do";
    const pdf = "/ct-tc/cdo/en/464621/1/document.do";
    const markup = `
      <li class="documents"><a href="${pdf}">PDF</a></li>
      <div id="decisia-decision-pdf-only"><a href="${pdf}">Download</a></div>`;

    expect(verifiedDecisiaPdf(markup, canonical)).toEqual({
      url: "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/464621/1/document.do",
      pdfOnly: true,
    });
  });

  it("treats FC item 40083's empty documents control as no PDF", () => {
    const canonical =
      "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/40083/index.do";
    const markup = '<li class="documents">\n</li>';
    expect(verifiedDecisiaPdf(markup, canonical)).toBeNull();
    expect(deriveOriginalPdfCandidates({ canonicalUrl: canonical, markup })).toEqual([]);
  });

  it("rejects document links outside Decisia representation controls", () => {
    const canonical =
      "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/40083/index.do";
    const markup = `<article><a href="/fc-cf/decisions/en/530291/1/document.do">
      cited judgment</a></article>`;
    expect(verifiedDecisiaPdf(markup, canonical)).toBeNull();
    expect(deriveOriginalPdfCandidates({ canonicalUrl: canonical, markup })).toEqual([]);
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
