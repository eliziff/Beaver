import { type A2AJCompiledDocument, type A2AJLocatorKind } from "./legalSources/a2aj";
import { structureNative, type NativeDocument,
  type NativeTextFragmentPlan } from "./structureNative";
import type { VerifiedPdfEvidence } from "./legalSourcePresentation";

/**
 * Deterministic pinpoint URLs: a provider anchor where one exists, plus text
 * fragments verified to select exactly one place in the document.
 *
 * Everything here queries the canonical native document.
 */

export type LegalSourceEvidence = {
  url: string;
  verifiedPdf?: VerifiedPdfEvidence | null;
  anchor?: string;
  /** The passage the quote must appear in. */
  blockText: string;
  /**
   * The corpus the fragment must be unique in. Required: without it a
   * directive can only be spelled blind, and Chrome then paints the first
   * matching text anywhere in the document rather than the cited passage.
   */
  documentText: NativeDocument;
  pageScoped?: boolean;
};

/** The citation engine's reading of a source's address (common-law-cite url.rs). */
const engine = <T>(method: string, request: object) =>
  structureNative().citationEngineCall(method, JSON.stringify(request)) as T;

/** The anchor a source's page has for a locator its reading labels ("par12", "page 3", "2(1)"): CanLII's and
 *  Decisia's paragraph anchors, a PDF's page, CanLII's section and subsection anchors. */
export function legalSourceLocatorAnchor(rawUrl: string | null, kind: A2AJLocatorKind, label: string) {
  return rawUrl ? engine<string | null>("sourceAnchor", { url: rawUrl, kind, label }) ?? undefined : undefined;
}

/**
 * Canonical publisher URL for a legal source: the citation engine's link to it (a CanLII PDF opens its page, a PDF
 * keeps only a page anchor) at `anchor` where given, else the anchor it has, with the parameters a Decisia decision's
 * viewer needs; null for an address that is not http(s) or cannot be linked. A path on this host stays one.
 */
export function sourceUrl(rawUrl: string, anchor?: string): string | null {
  const local = rawUrl.startsWith("/") && !rawUrl.startsWith("//") && !rawUrl.includes("\\");
  let address = rawUrl;
  if (local) {
    try { address = new URL(rawUrl, "http://mike.local").href; } catch { return null; }
  }
  const linked = engine<string | null>("sourceUrl", { url: address, ...anchor !== undefined && { anchor } });
  if (!linked || !local) return linked;
  const url = new URL(linked);
  return url.origin === "http://mike.local" ? `${url.pathname}${url.search}${url.hash}` : null;
}

/** A path on this host, as the absolute address the engine reads, and the engine's answer as a path again. */
const LOCAL = "http://mike.local";
const isLocal = (rawUrl: string) => rawUrl.startsWith("/") && !rawUrl.startsWith("//") && !rawUrl.includes("\\");
const toEngine = (rawUrl: string) => isLocal(rawUrl) ? new URL(rawUrl, LOCAL).href : rawUrl;
function fromEngine(linked: string | null, local: boolean) {
  if (!linked || !local) return linked;
  const url = new URL(linked);
  return url.origin === LOCAL ? `${url.pathname}${url.search}${url.hash}` : null;
}

export function buildA2AJDocumentPinpointUrl(
  source: A2AJCompiledDocument, locator: { kind: A2AJLocatorKind; label: string },
  blockText: string, quotes: string[],
  requireComplete = false,
) {
  const document = source.searchNative;
  const complete = (plan: NativeTextFragmentPlan | null | undefined) => !requireComplete || !!plan?.sourceSafeComplete;
  // The passage on the provider's page A2AJ's text came from; else on A2AJ Law Web, which renders that text; else, with
  // a fragment, on the document's CanLII page. None: the caller's plain authority link.
  const publisher = source.url ? buildLegalSourcePinpoint({
    url: source.url, verifiedPdf: source.verifiedPdf,
    anchor: legalSourceLocatorAnchor(source.url, locator.kind, locator.label),
    blockText, documentText: document,
  }, quotes, source.docType === "laws") : null;
  if (publisher && complete(publisher.plan)) return publisher.target;
  const lawWeb = structureNative().lawWebLink(document, source.citation, source.docType ?? "cases", blockText, quotes);
  if (lawWeb) return lawWeb;
  const canliiUrl = source.docType === "laws" ? structureNative().canliiLawUrl(source.citation)
    : structureNative().canliiCaseUrl([source.citation, source.alternateCitation ?? ""].filter(Boolean),
      source.language, source.dataset);
  const canlii = canliiUrl ? buildLegalSourcePinpoint({ url: canliiUrl,
    anchor: legalSourceLocatorAnchor(canliiUrl, locator.kind, locator.label), blockText, documentText: document,
  }, quotes) : null;
  return canlii?.plan?.directives.length && complete(canlii.plan) ? canlii.target : null;
}

/** The engine's link for a passage (legal-structure passage_links), kept for the passages planned most recently: a
 *  quote check plans its links off the JavaScript thread first, and the workbook it feeds asks for them again. */
const LINKS_KEPT = 512;
type PassageLinkRequest = Parameters<ReturnType<typeof structureNative>["passageLink"]>[1];
type PassageLink = ReturnType<ReturnType<typeof structureNative>["passageLink"]>;
const links = new Map<string, PassageLink>();
const linkKey = (document: NativeDocument, request: PassageLinkRequest) =>
  JSON.stringify([structureNative().documentRevision(document), request]);
function keepLink(key: string, link: PassageLink) {
  links.delete(key);
  links.set(key, link);
  if (links.size > LINKS_KEPT) links.delete(links.keys().next().value!);
}
const linkRequest = (evidence: Pick<LegalSourceEvidence, "url" | "anchor" | "blockText" | "verifiedPdf">,
  quotes: string[], preferIndependentHtmlBlocks = false): PassageLinkRequest => ({
  url: toEngine(evidence.url), ...evidence.anchor !== undefined && { anchor: evidence.anchor },
  blockText: evidence.blockText, quotes, preferIndependentHtmlBlocks,
  verifiedPdf: evidence.verifiedPdf ? { url: evidence.verifiedPdf.url, pdfOnly: evidence.verifiedPdf.pdfOnly } : null,
});

/** Plans ahead, off this thread, the links that buildLegalSourcePinpoint first asks for each of a document's
 *  passages (each at its own address): a quote check links each quotation it finds. */
export async function planLegalSourcePinpoints(document: NativeDocument,
  passages: Array<{ url: string; anchor?: string; blockText: string; quotes: string[] }>) {
  await Promise.all(passages.filter(({ blockText }) => blockText).map(async (passage) => {
    const request = linkRequest(passage, passage.quotes);
    const key = linkKey(document, request);
    if (!links.has(key)) keepLink(key, await structureNative().offThread("passageLink", document, request));
  }));
}

/** The passage's link at its page: the page at the passage's anchor with its block's or quotations' fragments
 *  (a verified PDF where only that plans whole), from the engine. */
export function buildLegalSourcePinpoint(
  evidence: LegalSourceEvidence,
  quotes: string[],
  preferIndependentHtmlBlocks = false,
) {
  const request = linkRequest(evidence, quotes, preferIndependentHtmlBlocks);
  const key = linkKey(evidence.documentText, request);
  const link = links.has(key) ? links.get(key)! : structureNative().passageLink(evidence.documentText, request);
  keepLink(key, link);
  const target = link && fromEngine(link.target, isLocal(evidence.url));
  return link && target ? { target, plan: link.plan } : null;
}

export function buildLegalSourcePinpointUrl(evidence: LegalSourceEvidence, quotes: string[]) {
  return buildLegalSourcePinpoint(evidence, quotes)?.target ?? null;
}

/** Add complete source-anchored text fragments beside the existing paragraph or provision anchor. A provision link
 *  paints the part of the provision its citation pinpoints ("sec16(3)", "sec445(1)(a)") where the document has it,
 *  else the provision's opening block. Each plan runs off the JavaScript thread, so a workbook plans its links at once. */
export async function citedPassageLink(rawUrl: string, document: NativeDocument | null | undefined,
  pinpoints: readonly string[] = []) {
  const url = sourceUrl(rawUrl);
  if (!url || !document) return url;
  const linked = await structureNative().offThread("citedPassageLink", document, toEngine(url), [...pinpoints]);
  return fromEngine(linked, isLocal(url)) ?? url;
}

/** A Canadian decision's page: one whose paragraphs the citation engine anchors (a CanLII or Decisia decision), or a
 *  B.C. court's or the Supreme Court's case page. */
function isCanadianDecisionUrl(url: URL) {
  const host = url.hostname.replace(/^www\./iu, "");
  const path = url.pathname.toLowerCase();
  return !!legalSourceLocatorAnchor(url.href, "paragraph", "par1") ||
    (host === "bccourts.ca" && path.includes("/jdb-txt/")) ||
    (host === "scc-csc.ca" && path.includes("/case-dossier/"));
}

function hasCanadianCaseCitation(value: string) {
  return structureNative().providerCitationsInText(value).some(({ family, year, court }) => {
    const dataset = court?.toUpperCase() ?? "";
    return family === "neutral" &&
      (year?.startsWith("19") || year?.startsWith("20")) &&
      structureNative().canliiCourtRoute(dataset);
  });
}

/**
 * Whether the answer links a Canadian decision the model must not cite by URL.
 * The markdown pass runs first because a link whose label already carries a
 * Canadian citation collapses to that label, taking its URL out of the scan.
 */
export function hasCanadianDecisionLink(answer: string) {
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
  answer
    .replace(/\[([^\]\r\n]+)\]\(([^)\r\n]*)\)/gu,
      (full, label: string) => (hasCanadianCaseCitation(label) ? label : full))
    .replace(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
      (full, label: string, url: string) => (strip(url) ? full : label))
    .replace(/https?:\/\/[^\s<>"')\]]+/gu, (url) => {
      const suffix = url.match(/[.,;:!?]+$/u)?.[0] ?? "";
      const target = suffix ? url.slice(0, -suffix.length) : url;
      return strip(target) ? url : suffix;
    });
  return found;
}
