import { describe, expect, it } from "vitest";
import { publisherPdfSourceUrl, publisherPdfCandidate, rankedPublisherPdfLinks, verifiedDecisiaPdf } from "../legalSourcePresentation";

it('validates publisher URLs consistently for browser downloads', () => {
  expect(publisherPdfSourceUrl('http://www.bccourts.ca/jdb-txt/sc/24/0123.htm?tracking=1#para3')?.href)
    .toBe('https://www.bccourts.ca/jdb-txt/sc/24/0123.htm');
  expect(publisherPdfSourceUrl('https://decisions.scc-csc.ca/scc-csc/scc-csc/en/7976/document.do')?.hostname)
    .toBe('decisions.scc-csc.ca');
  for (const url of ['https://canlii.org/en/ca/scc/doc/2011/2011scc58/2011scc58.pdf',
    'https://decisions.scc-csc.ca.evil.example/scc/en/7976/document.do',
    'https://user:password@decisions.scc-csc.ca/scc/en/7976/document.do',
    'https://decisions.scc-csc.ca:8443/scc/en/7976/document.do',
    'https://decisions.scc-csc.ca/scc/en/%2f7976/document.do'])
    expect(publisherPdfSourceUrl(url)).toBeNull();
});

describe("verified Decisia PDF evidence", () => {
  it("limits candidates to safe supported case URLs and removes navigation state", () => {
    expect(publisherPdfCandidate("https://decisions.scc-csc.ca/scc-csc/scc-csc/fr/item/14438/index.do?iframe=true#par4"))
      .toBe("https://decisions.scc-csc.ca/scc-csc/scc-csc/fr/14438/1/document.do");
    for (const url of ["not a URL", "http://decisions.scc-csc.ca/a/item/1/index.do",
      "https://user:password@decisions.scc-csc.ca/a/item/1/index.do",
      "https://decisions.scc-csc.ca.evil.example/a/item/1/index.do",
      "https://www.bccourts.ca/jdb-txt/CA/12/04/2012BCCA0480.htm",
      "https://decisions.scc-csc.ca/a%2fb/item/1/index.do",
      "https://decisions.scc-csc.ca/a/1/1/document.do"])
      expect(publisherPdfCandidate(url)).toBeNull();
  });
  it.each([
    "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/14438/index.do",
    "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/530291/index.do",
    "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/464621/index.do",
    "https://decisia.lexum.com/nsc/nssc/en/item/42/index.do",
  ])("derives a download candidate without claiming representation evidence: %s", (url) => {
    expect(publisherPdfCandidate(url)).toBe(url.replace(/\/item\/(\d+)\/index.do$/, "/$1/1/document.do"));
    expect(verifiedDecisiaPdf("", url)).toBeNull();
  });
  it("accepts the PDF anchor in the Decisia documents control", () => {
    const canonical =
      "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/530291/index.do";
    const markup = `<li class="documents"><a
      href="/fc-cf/decisions/en/530291/1/document.do">PDF</a></li>`;
    expect(verifiedDecisiaPdf(markup, canonical)).toEqual({
      url: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/530291/1/document.do",
      pdfOnly: false,
    });
  });
  it("reads current div documents controls without following judgment-body citations", () => {
    const url = "https://decisions.courts.ns.ca/nsc/nssc/en/item/42/index.do";
    expect(verifiedDecisiaPdf('<div class="documents"><a href="/nsc/nssc/en/42/1/document.do">PDF</a></div>', url))
      .toEqual({ url: "https://decisions.courts.ns.ca/nsc/nssc/en/42/1/document.do", pdfOnly: false });
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
  });

  it("rejects document links outside Decisia representation controls", () => {
    const canonical =
      "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/40083/index.do";
    const markup = `<article><a href="/fc-cf/decisions/en/530291/1/document.do">
      cited judgment</a></article>`;
    expect(verifiedDecisiaPdf(markup, canonical)).toBeNull();
  });

  it("follows the same-origin Decisia decision frame to its PDF control", () => {
    const canonical =
      "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/21505/index.do";
    expect(rankedPublisherPdfLinks(
      '<iframe src="/scc-csc/scc-csc/en/item/21505/index.do?iframe=true"></iframe>',
      canonical,
    )).toEqual([
      "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/21505/index.do?iframe=true",
    ]);
  });
});

it.each(['decisions.scc-csc.ca', 'decisions.fct-cf.gc.ca', 'decisions.courts.ns.ca'])(
  'accepts current div representation controls at %s', host => {
    const index = `https://${host}/court/cases/en/item/123/index.do`;
    const pdf = '/court/cases/en/123/1/document.do';
    expect(verifiedDecisiaPdf(`<div class="documents"><a href="${pdf}">PDF</a></div>`, index))
      .toEqual({ url: `https://${host}${pdf}`, pdfOnly: false });
    expect(verifiedDecisiaPdf(`<div class="judgment"><a href="${pdf}">Citation</a></div>`, index)).toBeNull();
  });
