import { type A2AJCompiledDocument, type A2AJLocatorKind } from "./legalSources/a2aj";
import { structureNative, type NativeDocument,
  type NativeTextFragmentPlan } from "./structureNative";
import type { VerifiedPdfEvidence } from "./legalSourcePresentation";
import { buildA2AJWebPinpointUrl } from "./a2ajWebLinks";

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
  const plan = structureNative().textFragmentPlan(blockText, quotes, false, false, true, document);
  const lawWeb = complete(plan) ? buildA2AJWebPinpointUrl(source, plan) : null;
  if (lawWeb) return lawWeb;
  const canliiUrl = source.docType === "laws" ? structureNative().canliiLawUrl(source.citation)
    : structureNative().canliiCaseUrl([source.citation, source.alternateCitation ?? ""].filter(Boolean),
      source.language, source.dataset);
  const canlii = canliiUrl ? buildLegalSourcePinpoint({ url: canliiUrl,
    anchor: legalSourceLocatorAnchor(canliiUrl, locator.kind, locator.label), blockText, documentText: document,
  }, quotes) : null;
  return canlii?.plan?.directives.length && complete(canlii.plan) ? canlii.target : null;
}

/** The engine's text fragment plan, a pure reading of a block, its quotations and its document (by revision), kept
 *  for the passages planned most recently: a quote check plans a link and the workbook it feeds plans it again. */
const PLANS_KEPT = 512;
const plans = new Map<string, NativeTextFragmentPlan>();
const planKey = (blockText: string, quotes: string[], pdf: boolean, annotated: boolean, split: boolean,
  document: NativeDocument) => JSON.stringify([structureNative().documentRevision(document), blockText, quotes, pdf,
  annotated, split]);
function keepPlan(key: string, plan: NativeTextFragmentPlan) {
  plans.delete(key);
  plans.set(key, plan);
  if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value!);
}
function plannedFragments(blockText: string, quotes: string[], pdf: boolean, annotated: boolean, split: boolean,
  document: NativeDocument) {
  const key = planKey(blockText, quotes, pdf, annotated, split, document);
  const plan = plans.get(key) ?? structureNative().textFragmentPlan(blockText, quotes, pdf, annotated, split, document);
  keepPlan(key, plan);
  return plan;
}

/** Plans ahead, off this thread and all in one call, the text fragments that buildLegalSourcePinpoint first asks for
 *  each of a document's passages (each at its own address): a quote check links each quotation it finds. */
export async function planLegalSourcePinpoints(document: NativeDocument,
  passages: Array<{ url: string; anchor?: string; blockText: string; quotes: string[] }>) {
  const requests = passages.flatMap(({ url, anchor, blockText, quotes }) => {
    const baseUrl = sourceUrl(url, anchor);
    if (!baseUrl || !blockText) return [];
    const request = { blockText, quotes, pdf: isPdfSourceUrl(baseUrl),
      publisherMayAnnotateLegalReference: publisherMayAnnotateLegalReference(baseUrl), splitHtmlSourceBlocks: false };
    return plans.has(planKey(blockText, quotes, request.pdf, request.publisherMayAnnotateLegalReference, false, document))
      ? [] : [request];
  });
  if (!requests.length) return;
  const planned = await structureNative().textFragmentPlans(document, requests);
  requests.forEach((request, index) => keepPlan(planKey(request.blockText, request.quotes, request.pdf,
    request.publisherMayAnnotateLegalReference, false, document), planned[index]));
}

export function buildLegalSourcePinpoint(
  evidence: LegalSourceEvidence,
  quotes: string[],
  preferIndependentHtmlBlocks = false,
) {
  const baseUrl = sourceUrl(evidence.url, evidence.anchor);
  if (!baseUrl) return null;
  if (!evidence.blockText) return { target: baseUrl, plan: null };
  const plan = (url: string, pdf: boolean) => {
    const fragmentPlan = (splitHtmlSourceBlocks: boolean) =>
      plannedFragments(evidence.blockText, quotes, pdf,
        publisherMayAnnotateLegalReference(url), splitHtmlSourceBlocks,
        evidence.documentText);
    const base = fragmentPlan(false);
    const [directive] = base.directives;
    const value = directive?.slice("text=".length) ?? "";
    const simpleRange = base.directives.length === 1 && value.split(",").length === 2 &&
      !value.includes("-,") && !value.includes(",-");
    if (!preferIndependentHtmlBlocks || pdf || !simpleRange) return base;
    const blocks = fragmentPlan(true);
    return blocks.sourceSafeComplete && blocks.directives.length >= 2 &&
      blocks.paintedWords === base.paintedWords && structureNative()
        .documentTextStatistics(evidence.documentText, blocks.paintQuotes).every(({ occurrences }) => occurrences === 1)
      ? blocks : base;
  };
  const verifiedPdfUrl = evidence.verifiedPdf
    ? sourceUrl(evidence.verifiedPdf.url, evidence.anchor) : null;
  let targetUrl = baseUrl;
  let pdf = isPdfSourceUrl(targetUrl);
  if (!pdf && evidence.verifiedPdf?.pdfOnly && verifiedPdfUrl) {
    targetUrl = verifiedPdfUrl;
    pdf = true;
  }
  let selected = plan(targetUrl, pdf);
  if (!pdf && !selected.sourceSafeComplete && verifiedPdfUrl) {
    const fallback = plan(verifiedPdfUrl, true);
    if (fallback.sourceSafeComplete || fallback.paintedWords > selected.paintedWords) {
      targetUrl = verifiedPdfUrl;
      selected = fallback;
    }
  }
  return { target: appendDirectives(targetUrl, selected.directives), plan: selected };
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
  const locator = engine<{ kind: "paragraph" | "section"; label: string; part?: string } | null>("passageLocator",
    { url, pinpoints });
  if (!locator) return url;
  // Provision links target the opening block of the provision or pinpointed part; paragraph links include every exact
  // member of the resolved paragraph.
  const plan = async (target: string) => {
    const found = await structureNative().offThread("documentRangeFragmentPlan", document, locator.kind,
      target, target, isPdfSourceUrl(url), publisherMayAnnotateLegalReference(url), locator.kind === "section");
    return found?.sourceSafeComplete && found.directives.length ? found : null;
  };
  const { label, part } = locator;
  const planned = (part && await plan(part)) || await plan(label);
  return planned ? appendDirectives(url, planned.directives) : url;
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
