import {
  type A2AJCompiledDocument,
  type A2AJLocatorKind,
} from "./legalSources/a2aj";
import {
  structureNative,
  type NativeDocument,
} from "./structureNative";
import type { VerifiedPdfEvidence } from "./legalSourcePresentation";
import { A2AJ_CANLII_COURT_ROUTES } from "./canliiUrls";
import { buildA2AJWebPinpointUrl } from "./a2ajWebLinks";

/**
 * Deterministic pinpoint URLs: a provider anchor where one exists, plus text
 * fragments verified to select exactly one place in the document.
 *
 * Everything here queries the canonical native document.
 */

type A2AJCitationIdentity = {
  citation: string | null;
  name: string | null;
  dataset: string | null;
  url: string | null;
  quotes: { quote: string }[];
};

export type LegalSourceEvidence = {
  url: string;
  verifiedPdf?: VerifiedPdfEvidence | null;
  anchor?: string;
  /** The passage the quote must appear in. */
  blockText: string;
  /** The corpus the fragment must be unique in. */
  documentText: NativeDocument;
  pageScoped?: boolean;
};

// Decisia/Norma deployments (SCC, FCA, FC, TCC, ONCA, NSCA, tribunals, and
// decisia.lexum.com tenants). Their default document URL is an iframe shell
// with no text and no anchors; `?iframe=true` serves the document inline
// with `name="parN"` paragraph anchors. Live-verified across 14 hosts on
// 2026-07-27. Detection is by host+path because A2AJ supplies markdown, not
// the source HTML — per-document anchor presence cannot be known here, and
// some older documents (e.g. pre-2013 SCC items) carry no anchors at all.
const DECISIA_HOSTS =
  /^(decisions?\.[\w-]+\.(?:gc\.)?ca|decisia\.lexum\.com|coadecisions\.ontariocourts\.ca)$/iu;

function isDecisiaDocument(url: URL) {
  return (
    DECISIA_HOSTS.test(url.hostname) &&
    /\/item\/\d+\/index\.do$/iu.test(url.pathname)
  );
}

export function legalSourceLocatorAnchor(
  rawUrl: string | null,
  kind: A2AJLocatorKind,
  label: string,
) {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const canlii = /(^|\.)canlii\.org$/iu.test(url.hostname);
  if (kind === "paragraph") {
    const number = label.match(/^par(\d+)/iu)?.[1];
    return number &&
      ((canlii && url.pathname.includes("/doc/")) || isDecisiaDocument(url))
      ? `par${Number(number)}`
      : undefined;
  }
  if (kind === "page") {
    const number = label.match(/^(?:page=?)?(\d+)/iu)?.[1];
    return number && url.pathname.toLowerCase().endsWith(".pdf")
      ? `page=${Number(number)}`
      : undefined;
  }
  const section = label.match(/^sec[\w.-]+/iu)?.[0];
  return section && canlii && url.pathname.includes("/laws/")
    ? section
    : undefined;
}

function sourceUrl(rawUrl: string, anchor?: string): string | null {
  const local =
    rawUrl.startsWith("/") &&
    !rawUrl.startsWith("//") &&
    !rawUrl.includes("\\");
  let url: URL;
  try {
    url = local ? new URL(rawUrl, "http://mike.local") : new URL(rawUrl);
  } catch {
    return null;
  }
  if (/(^|\.)getcaselaw\.com$/iu.test(url.hostname)) return null;
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (local && url.origin !== "http://mike.local")
  ) {
    return null;
  }

  const existingAnchor = url.hash.slice(1).split(":~:", 1)[0];
  const bclaws = /(^|\.)bclaws\.gov\.bc\.ca$/iu.test(url.hostname);
  if (bclaws && url.pathname.endsWith("/xml")) {
    url.pathname = url.pathname.slice(0, -4);
  }
  let justiceLawsHtml = false;
  if (/^laws-lois\.justice\.gc\.ca$/iu.test(url.hostname)) {
    const justiceXml = url.pathname.match(/^\/(eng|fra)\/XML\/([^/]+)\.xml$/iu);
    if (justiceXml) {
      const language = justiceXml[1].toLocaleLowerCase();
      const identifier = justiceXml[2];
      let decodedIdentifier = identifier;
      try {
        decodedIdentifier = decodeURIComponent(identifier);
      } catch {
        // Keep the literal path segment; URL parsing already validated it.
      }
      const regulation = /^(?:SOR|SI|C\.?R\.?C\.?|DORS|TR)\b/iu.test(
        decodedIdentifier,
      );
      const collection = language === "fra"
        ? regulation ? "reglements" : "lois"
        : regulation ? "regulations" : "acts";
      url.pathname = `/${language}/${collection}/${identifier}/FullText.html`;
      justiceLawsHtml = true;
    }
  }
  if (/^(?:www\.)?ontario\.ca$/iu.test(url.hostname)) {
    const elaws = url.pathname.match(
      /^\/laws\/api\/v2\/legislation\/en\/doc-search\/(statute|regulation)\/([^/]+)$/iu,
    );
    if (elaws) {
      url.hostname = "www.ontario.ca";
      url.pathname = `/laws/${elaws[1].toLocaleLowerCase()}/${elaws[2]}`;
    }
  }
  const canliiPdf =
    /(^|\.)canlii\.org$/iu.test(url.hostname) &&
    url.pathname.toLowerCase().endsWith(".pdf");
  const requestedAnchor = anchor ?? existingAnchor;
  const convertedCanliiPdf = canliiPdf && !requestedAnchor.startsWith("page=");
  if (convertedCanliiPdf) {
    url.pathname = url.pathname.replace(/\.pdf$/iu, ".html");
  }
  if (isDecisiaDocument(url)) {
    // INTENTIONAL, LOAD-BEARING FEATURE - text fragments cannot work on
    // Decisia without both parameters. This is not a flaw, lint, or
    // cosmetic preference; do not remove or "normalize" either one.
    //
    // iframe=true: the default Decisia document URL is an iframe shell with
    // no document text at all, so neither paragraph anchors nor
    // #:~:text= directives can resolve against it. iframe=true serves the
    // document inline.
    //
    // site_preference=mobile: in the desktop rendering, a successful
    // text-fragment jump locks the viewport onto the matched text and the
    // page cannot be scrolled afterwards. Only the mobile rendering scrolls
    // normally after a fragment jump. Both behaviors were verified in live
    // Chrome; server-side probes and static HTML inspection cannot see
    // them, so an apparent absence of justification here is not evidence
    // the parameters are removable.
    //
    // Side effect, deliberately accepted: Decisia remembers site_preference
    // in a cookie. That only affects visitors who arrive via Beaver's deep
    // links. A regular user browsing the publisher normally clicks plain
    // desktop URLs and sees the identical desktop site - their experience
    // is completely unchanged.
    url.searchParams.delete("iframe");
    url.searchParams.delete("site_preference");
    url.searchParams.set("iframe", "true");
    url.searchParams.set("site_preference", "mobile");
  }

  let resolvedAnchor =
    anchor !== undefined ? anchor : convertedCanliiPdf ? "" : existingAnchor;
  if (/\/document\.do$/iu.test(url.pathname) || url.pathname.toLowerCase().endsWith(".pdf")) {
    resolvedAnchor = /^page=\d+$/iu.test(resolvedAnchor) ? resolvedAnchor : "";
  }
  if (bclaws) {
    resolvedAnchor = resolvedAnchor.replace(
      /^sec(\d+(?:\.\d+)*)(?:\(.*\))?$/iu,
      "section$1",
    );
  }
  if (justiceLawsHtml) {
    resolvedAnchor = /^h-\d+$/iu.test(existingAnchor) ? existingAnchor : "";
  }
  url.hash = resolvedAnchor ? `#${resolvedAnchor}` : "";
  return local ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

function appendDirectives(url: string, directives: string[]) {
  if (!directives.length) return url;
  return url.includes("#")
    ? `${url}:~:${directives.join("&")}`
    : `${url}#:~:${directives.join("&")}`;
}

function isPdfSourceUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl, "http://mike.local");
    const path = url.pathname.toLocaleLowerCase();
    const href = url.href.toLocaleLowerCase();
    return path.endsWith(".pdf") || path.endsWith("/document.do") ||
      url.searchParams.get("rendition")?.toLocaleLowerCase() === "pdf" ||
      href.includes("laws.yukon.ca/cms/images/legislation/") ||
      href.includes("justice.gov.nt.ca/en/files/legislation/") ||
      href.includes("princeedwardisland.ca/sites/default/files/legislation/") ||
      /publications\.saskatchewan\.ca\/api\/v1\/products\/[^/]+\/formats\//u.test(href);
  } catch {
    const path = rawUrl.toLocaleLowerCase().split(/[?#]/u, 1)[0];
    return path.endsWith(".pdf") || path.endsWith("/document.do");
  }
}

function publisherMayAnnotateLegalReference(rawUrl: string) {
  try {
    return new URL(rawUrl, "http://mike.local").hostname === "www.bclaws.gov.bc.ca";
  } catch {
    return false;
  }
}

function buildA2AJSourcePinpointUrl(
  source: Pick<
    A2AJCompiledDocument,
    "docType" | "dataset" | "citation" | "alternateCitation" | "name" |
      "date" | "language" | "url" | "verifiedPdf" | "searchText"
  >,
  locator: { kind: A2AJLocatorKind; label: string },
  blockText: string,
  quotes: string[],
  document: NativeDocument,
) {
  const pinpoint = source.url
    ? buildLegalSourcePinpoint({
        url: source.url,
        verifiedPdf: source.verifiedPdf,
        anchor: legalSourceLocatorAnchor(source.url, locator.kind, locator.label),
        blockText,
        documentText: document,
      }, quotes)
    : null;
  if (pinpoint) return pinpoint.target;
  const plan = structureNative().textFragmentPlan(
    blockText,
    quotes,
    false,
    false,
    document,
  );
  return buildA2AJWebPinpointUrl(source, plan);
}

export function buildLegalSourcePinpoint(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  const baseUrl = sourceUrl(evidence.url, evidence.anchor);
  if (!baseUrl) return null;
  if (!evidence.blockText) return { target: baseUrl, plan: null };
  const plan = (url: string, pdf: boolean) => structureNative().textFragmentPlan(
    evidence.blockText,
    quotes,
    pdf,
    publisherMayAnnotateLegalReference(url),
    evidence.documentText,
  );
  let targetUrl = baseUrl;
  let pdf = isPdfSourceUrl(targetUrl);
  if (!pdf && evidence.verifiedPdf?.pdfOnly) {
    const verifiedPdfUrl = sourceUrl(evidence.verifiedPdf.url, evidence.anchor);
    if (verifiedPdfUrl) {
      targetUrl = verifiedPdfUrl;
      pdf = true;
    }
  }
  let selected = plan(targetUrl, pdf);
  if (!pdf && !selected.sourceSafeComplete && evidence.verifiedPdf) {
    const verifiedPdfUrl = sourceUrl(evidence.verifiedPdf.url, evidence.anchor);
    if (verifiedPdfUrl) {
      const fallback = plan(verifiedPdfUrl, true);
      if (fallback.sourceSafeComplete || fallback.paintedWords > selected.paintedWords) {
        targetUrl = verifiedPdfUrl;
        selected = fallback;
      }
    }
  }
  return { target: appendDirectives(targetUrl, selected.directives), plan: selected };
}

export function buildLegalSourcePinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  return buildLegalSourcePinpoint(evidence, quotes)?.target ?? null;
}

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function identityMatches(
  citation: A2AJCitationIdentity,
  source: Pick<
    A2AJCompiledDocument,
    "citation" | "alternateCitation" | "dataset"
  >,
) {
  if (citation.citation) {
    const wanted = normalizedIdentity(citation.citation);
    if (
      ![source.citation, source.alternateCitation]
        .map(normalizedIdentity)
        .includes(wanted)
    ) {
      return false;
    }
  }
  if (
    citation.dataset &&
    normalizedIdentity(citation.dataset) !== normalizedIdentity(source.dataset)
  ) {
    return false;
  }
  return true;
}

function isCanadianDecisionUrl(url: URL) {
  return (
    isDecisiaDocument(url) ||
    ((url.hostname === "canlii.org" || url.hostname === "www.canlii.org") &&
      url.pathname.includes("/doc/")) ||
    ((url.hostname === "bccourts.ca" ||
      url.hostname === "www.bccourts.ca") &&
      url.pathname.toLowerCase().includes("/jdb-txt/")) ||
    ((url.hostname === "scc-csc.ca" ||
      url.hostname === "www.scc-csc.ca") &&
      url.pathname.toLowerCase().includes("/case-dossier/"))
  );
}

/** Rebuild the same A2AJ link after a prior-turn receipt has been rehydrated. */
export function buildA2AJDocumentPinpointUrl(
  document: A2AJCompiledDocument,
  locator: { kind: A2AJLocatorKind; label: string },
  blockText: string,
  quotes: string[],
  _source: NativeDocument | null = null,
) {
  return buildA2AJSourcePinpointUrl(
    document,
    locator,
    blockText,
    quotes,
    document.searchNative,
  );
}

function hasCanadianCaseCitation(value: string) {
  return structureNative().providerCitationsInText(value).some(({ family, year, court }) => {
    const dataset = court?.toUpperCase() ?? "";
    return family === "neutral" &&
      (year?.startsWith("19") || year?.startsWith("20")) &&
      dataset in A2AJ_CANLII_COURT_ROUTES;
  });
}

function rewriteModelCanadianDecisionUrls(answer: string) {
  let found = false;
  const strip = (rawUrl: string) => {
    try {
      if (!isCanadianDecisionUrl(new URL(rawUrl))) return rawUrl;
      found = true;
      return "";
    } catch {
      return rawUrl;
    }
  };
  const text = answer
    .replace(
      /\[([^\]\r\n]+)\]\(([^)\r\n]*)\)/gu,
      (full, label: string) =>
        hasCanadianCaseCitation(label) ? label : full,
    )
    .replace(
      /\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
      (full, label: string, url: string) => (strip(url) ? full : label),
    )
    .replace(/https?:\/\/[^\s<>"')\]]+/gu, (url) => {
      const suffix = url.match(/[.,;:!?]+$/u)?.[0] ?? "";
      const target = suffix ? url.slice(0, -suffix.length) : url;
      return strip(target) ? url : suffix;
    })
    .replace(/^[\t ]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n");
  return { found, text };
}

export function hasCanadianDecisionLink(answer: string) {
  return rewriteModelCanadianDecisionUrls(answer).found;
}

export function buildA2AJParagraphRangeUrl(
  citation: string,
  start: string,
  end: string,
  documents: A2AJCompiledDocument[],
) {
  const sources = new Map<
    NativeDocument,
    {
      source: NativeDocument;
      metadata: A2AJCompiledDocument;
    }
  >();
  for (const document of documents) {
    if (
      document.url &&
      identityMatches(
        { citation, name: null, dataset: null, url: null, quotes: [] },
        document,
      )
    ) {
      const source = document.native;
      sources.set(source, { source, metadata: document });
    }
  }
  const candidates = [...sources.values()].flatMap(({ source, metadata }) => {
    const directive = structureNative().documentParagraphRangeDirective(source, start, end);
    return directive === null ? [] : [{ metadata, directive }];
  });
  const structured = candidates.length === 1 ? candidates[0] : null;
  if (!structured?.directive) return null;
  const anchor = `par${Number(start)}`;
  const baseUrl = structured.metadata.url
    ? sourceUrl(structured.metadata.url, anchor)
    : null;
  return baseUrl ? appendDirectives(baseUrl, [structured.directive]) : null;
}
