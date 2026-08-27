import {
  type A2AJCompiledDocument,
  type A2AJLocatorKind,
} from "./legalSources/a2aj";
import {
  structureNative,
  type NativeDocument,
  type NativeTextFragmentPlan,
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
  docType?: A2AJCompiledDocument["docType"];
  verifiedPdf?: VerifiedPdfEvidence | null;
  anchor?: string;
  /** The passage the quote must appear in. */
  blockText: string;
  /** The corpus the fragment must be unique in. */
  documentText?: NativeDocument;
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

function normalizedFragmentText(value: string) {
  return value.normalize("NFKD").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
}

function fragmentWordCount(value: string) {
  const normalized = normalizedFragmentText(value);
  return normalized ? normalized.split(" ").length : 0;
}

function textOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0;
    at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
}

function fragmentOccurrences(documentText: string, value: string) {
  const needle = normalizedFragmentText(value);
  return needle ? textOccurrences(` ${documentText} `, ` ${needle} `) : 0;
}

const PUBLISHER_PDF_LONGEST_FIRST_SIGNATURES = new Set([
  "law|laws.yukon.ca|principal|1/2/2/1|4|4|safe|body|1/1/M/1|1/1M/MM/1|11|3/12/1/8|90",
  "law|www.justice.gov.nt.ca|act|1/2/1|3|3|safe|body|M/1/1|M/M1/1|7|5/8/3|76",
  "law|www.justice.gov.nt.ca|act|1/3/1/1/1/1|6|6|safe|early|M/1/1/1/1/1|M/1M1/1/1/1/1|20|2/8/6/8/1/3|383",
  "law|www.princeedwardisland.ca|asset|2/1|2|2|safe|opening|M/1|MM/1|8|1/7|214",
  "law|www.princeedwardisland.ca|legislation|1/1/1|3|3|safe|early|1/1/1|1/1/1|21|7/3/11|393",
  "law|www.princeedwardisland.ca|legislation|1/1|2|2|safe|body|1/1|1/1|16|7/9|90",
  "law|www.princeedwardisland.ca|legislation|1/1|2|2|safe|opening|1/1|1/1|8|1/7|384",
  "law|www.princeedwardisland.ca|legislation|1/1|2|2|safe|opening|M/1|M/1|8|2/6|360",
  "law|www.princeedwardisland.ca|legislation|2/1/3/1|4|4|safe|body|M/1/1/M|1M/1/1MM/M|16|1/13/15/2|52",
  "law|www.princeedwardisland.ca|legislation|2/1|2|2|safe|opening|M/1|MM/1|12|1/11|59",
]);

const PUBLISHER_PDF_RARITY_FIRST_SIGNATURES = new Set([
  "law|www.justice.gov.nt.ca|act|1/3/2/1|4|4|safe|body|M/1/M/1|M/MM1/MM/1|11|4/11/1/6|76",
  "law|www.princeedwardisland.ca|legislation|1/1|2|2|safe|opening|M/1|M/1|8|2/6|201",
  "law|www.princeedwardisland.ca|legislation|2/1|2|2|safe|opening|M/1|MM/1|8|1/7|228",
  "law|www.princeedwardisland.ca|legislation|2/1|2|2|safe|opening|M/1|MM/1|8|1/7|339",
]);

const LAW_WEB_FALLBACK_SIGNATURES = new Set([
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|11|16|16|63",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|11|17|17|66",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|11|72|72|108",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|11|72|72|125",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|11|9|9|172",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|1M|23|23|97",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|1M|9|10|53",
  "case|decisia.lexum.com|nsc|2|1|1|safe|body|1|MM|70|70|178",
  "case|decisia.lexum.com|nsc|3|1|1|safe|body|M|1MM|9|9|121",
  "case|decisia.lexum.com|nsc|3|1|1|safe|body|M|1MM|9|9|62",
  "case|decisia.lexum.com|nsc|3|1|1|safe|body|M|1MM|9|9|75",
  "case|decision.tcc-cci.gc.ca||1|1|1|safe|body|1|1|59|60|114",
  "case|decisions.chrt-tcdp.gc.ca||3|1|1|safe|body|M|1MM|9|9|283",
  "case|decisions.scc-csc.ca||1|1|1|safe|body|1|1|16|16|132",
  "case|decisions.scc-csc.ca||2|1|1|safe|body|1|11|23|23|87",
  "case|decisions.sst-tss.gc.ca||2|1|1|safe|body|1|11|71|72|146",
  "case|decisions.tatc.gc.ca||3|1|1|safe|body|M|1MM|9|9|78",
  "case|refugeelab.ca||2|1|1|safe|body|1|11|18|18|153",
  "case|refugeelab.ca||2|1|1|safe|early|1|11|24|24|58",
  "case|www.bccourts.ca|jdb-txt/ca|3|1|1|safe|body|M|1MM|9|9|79",
  "case|www.bccourts.ca|jdb-txt/sc|2|1|1|safe|body|1|11|23|23|70",
  "case|www.oic-ci.gc.ca||1|1|1|safe|body|1|1|22|22|59",
  "case|www.oic-ci.gc.ca||3|1|1|safe|body|M|1MM|9|9|102",
  "case|www.oic-ci.gc.ca||3|1|1|safe|body|M|1MM|9|9|67",
  "case|www.oic-ci.gc.ca||3|1|1|safe|body|M|1MM|9|9|94",
  "law|kings-printer.alberta.ca|acts|1|1|1|safe|opening|1|1|9|9|302",
  "law|kings-printer.alberta.ca|acts|2|1|1|safe|body|1|1M|17|17|91",
  "law|kings-printer.alberta.ca|acts|3|1|1|safe|body|M|1MM|9|9|55",
  "law|kings-printer.alberta.ca|regs|3|1|1|safe|body|M|MMM|9|9|43",
  "law|laws-lois.justice.gc.ca|eng/regulations|2|1|1|safe|body|1|1M|16|16|145",
  "law|laws-lois.justice.gc.ca|eng/regulations|2|1|1|safe|body|1|1M|21|22|310",
  "law|laws-lois.justice.gc.ca|eng/regulations|2|1|1|safe|body|1|1M|25|25|214",
  "law|laws-lois.justice.gc.ca|eng/regulations|2|1|1|safe|early|1|11|70|71|189",
  "law|laws-lois.justice.gc.ca|eng/regulations|2|1|1|safe|early|1|1M|16|16|330",
  "law|laws.gnb.ca|en/document/cs|1/1|2|2|safe|early|1/1|1/1|16|7/9|206",
  "law|laws.gnb.ca|en/document/cs|1/1|2|2|safe|opening|1/1|1/1|16|7/10|131",
  "law|laws.gnb.ca|en/document/cs|1/1|2|2|safe|opening|1/1|1/1|17|7/10|187",
  "law|laws.gnb.ca|en/document/cs|2|1|1|safe|opening|1|M1|16|16|80",
  "law|laws.yukon.ca|principal|1/1/2|3|3|safe|body|1/1/M|1/1/MM|12|8/3/1|145",
  "law|laws.yukon.ca|principal|1/1/3/1/1|5|5|safe|body|1/1/1/1/M|1/1/1MM/1/M|17|4/9/13/1/3|120",
  "law|laws.yukon.ca|principal|1/1/3/2|4|4|safe|body|1/1/1/M|1/1/1MM/MM|16|4/10/12/2|62",
  "law|laws.yukon.ca|principal|1/1|2|2|safe|body|1/M|1/M|17|8/9|53",
  "law|laws.yukon.ca|principal|1/2/2|3|3|safe|body|1/M/M|1/MM/MM|8|7/1/1|108",
  "law|laws.yukon.ca|principal|1/3/1|3|3|safe|body|1/1/M|1/MMM/M|7|4/7/3|62",
  "law|laws.yukon.ca|subordinate|1/1/1|3|3|safe|body|1/1/1|1/1/1|12|3/1/8|82",
  "law|laws.yukon.ca|subordinate|1/3/1/2|4|4|safe|early|M/1/1/M|M/MM1/1/MM|12|7/12/5/1|294",
  "law|laws.yukon.ca|subordinate|1/4/1/2|4|4|safe|early|M/1/1/M|M/1MMM/1/MM|14|4/14/7/3|124",
  "law|laws.yukon.ca|subordinate|2/3/1|3|3|safe|early|M/1/1|MM/MM1/1|7|2/7/5|91",
  "law|publications.saskatchewan.ca||1/1|2|2|safe|body|1/1|1/1|9|8/1|48",
  "law|web2.gov.mb.ca|laws/statutes|2|1|1|safe|body|1|11|19|21|151",
  "law|web2.gov.mb.ca|laws/statutes|2|1|1|safe|body|1|1M|19|19|93",
  "law|web2.gov.mb.ca|laws/statutes|2|1|1|safe|early|1|11|19|20|180",
  "law|web2.gov.mb.ca|laws/statutes|2|1|1|safe|early|1|MM|16|16|99",
  "law|web2.gov.mb.ca|laws/statutes|3|1|1|safe|body|1|MMM|14|14|180",
  "law|web2.gov.mb.ca|laws/statutes|3|1|1|safe|early|1|1M1|19|19|228",
  "law|www.bclaws.gov.bc.ca||2/1|2|2|safe|opening|M/1|MM/1|9|1/8|166",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|body|1|11|22|22|218",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|11|23|23|81",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|1M|21|21|217",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|1M|22|22|222",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|M1|21|21|166",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|M1|21|21|223",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|MM|19|19|231",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|early|1|MM|21|21|291",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|opening|1|M1|9|9|291",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|opening|1|MM|15|15|282",
  "law|www.bclaws.gov.bc.ca||2|1|1|safe|opening|1|MM|9|9|71",
  "law|www.bclaws.gov.bc.ca||3|1|1|safe|body|1|MM1|22|22|250",
  "law|www.bclaws.gov.bc.ca||4|1|1|safe|body|1|MMMM|22|22|255",
  "law|www.bclaws.gov.bc.ca||4|1|1|safe|opening|1|MMMM|9|9|231",
  "law|www.bclaws.gov.bc.ca||4|1|1|safe|opening|1|MMMM|9|9|250",
  "law|www.bclaws.gov.bc.ca||4|1|1|safe|opening|1|MMMM|9|9|273",
  "law|www.justice.gov.nt.ca|act|1/1/2|3|3|safe|body|1/1/M|1/1/MM|7|5/1/1|43",
  "law|www.justice.gov.nt.ca|act|1/1|2|2|safe|body|M/1|M/1|9|2/7|153",
  "law|www.justice.gov.nt.ca|act|1/3/1|3|3|safe|early|1/1/M|1/1MM/M|9|6/9/3|224",
  "law|www.justice.gov.nt.ca|act|1/4/1/1|4|4|safe|body|M/M/M/1|M/MMM1/M/1|21|8/15/7/7|348",
  "law|www.justice.gov.nt.ca|reg|1/1/2|3|3|safe|body|M/1/M|M/1/MM|8|4/5/1|56",
  "law|www.justice.gov.nt.ca|reg|1/1|2|2|safe|body|1/1|1/1|7|5/2|106",
  "law|www.justice.gov.nt.ca|reg|2/1/1|3|3|safe|body|M/1/1|MM/1/1|15|3/7/5|72",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|2|1|1|safe|body|1|11|16|16|61",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|2|1|1|safe|body|1|1M|16|16|124",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|2|1|1|safe|body|1|1M|22|22|47",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|2|1|1|safe|body|1|1M|22|22|80",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|2|1|1|safe|body|1|1M|26|26|119",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|2|1|1|safe|body|1|1M|9|9|298",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|3|1|1|safe|body|M|1MM|9|9|89",
  "law|www.legisquebec.gouv.qc.ca|en/document/cr|3|1|1|safe|body|M|MMM|9|9|66",
  "law|www.ontario.ca|laws/regulation|1|1|1|safe|opening|1|1|9|9|159",
  "law|www.ontario.ca|laws/regulation|1|1|1|safe|opening|1|1|9|9|208",
  "law|www.ontario.ca|laws/statute|1|1|1|safe|opening|1|1|9|9|200",
  "law|www.ontario.ca|laws/statute|1|1|1|safe|opening|1|1|9|9|261",
  "law|www.princeedwardisland.ca|asset|2/1/1|3|3|safe|body|M/1/1|1M/1/1|21|3/15/3|57",
  "law|www.princeedwardisland.ca|asset|2/1|2|2|safe|opening|M/1|MM/1|8|1/7|163",
  "law|www.princeedwardisland.ca|legislation|1/1/2|3|3|safe|early|M/1/M|M/1/MM|19|3/15/1|201",
  "law|www.princeedwardisland.ca|legislation|2/1|2|2|safe|opening|M/1|MM/1|8|1/7|181",
  "law|www.princeedwardisland.ca|legislation|2/1|2|2|safe|opening|M/1|MM/1|8|1/7|393",
  "law|www.princeedwardisland.ca|legislation|2/2/3|3|3|safe|body|M/M/M|MM/M1/MM1|9|3/6/6|58",
]);

function occurrenceClass(documentText: string, value: string) {
  const count = fragmentOccurrences(documentText, value);
  return count === 0 ? "0" : count === 1 ? "1" : "M";
}

function fallbackUrlFamily(url: URL) {
  const host = url.hostname.toLocaleLowerCase("en");
  const segments = url.pathname.toLocaleLowerCase("en").split("/").filter(Boolean);
  if (host === "decisia.lexum.com") return segments[0] ?? "";
  if (host === "www.bccourts.ca") return segments.slice(0, 2).join("/");
  if (host === "kings-printer.alberta.ca") {
    return url.searchParams.get("leg_type")?.toLocaleLowerCase("en") ?? "";
  }
  if (host === "laws-lois.justice.gc.ca" || host === "web2.gov.mb.ca") {
    return segments.slice(0, 2).join("/");
  }
  if (host === "laws.gnb.ca" || host === "www.legisquebec.gouv.qc.ca") {
    return segments.slice(0, 3).join("/");
  }
  if (host === "www.ontario.ca") return segments.slice(0, 2).join("/");
  if (host === "www.princeedwardisland.ca") {
    return segments[3] === "legislation" ? "legislation" : "asset";
  }
  if (host === "laws.yukon.ca") return segments[3] ?? "";
  if (host === "www.justice.gov.nt.ca") {
    return /\.a\.pdf$/iu.test(url.pathname) ? "act"
      : /\.r\d*\.pdf$/iu.test(url.pathname) ? "reg" : "pdf";
  }
  return "";
}

function fallbackSignature(
  docType: A2AJCompiledDocument["docType"],
  publisherUrl: string,
  plan: NativeTextFragmentPlan,
  documentText: string,
  blockText: string,
) {
  const url = new URL(publisherUrl);
  const fullText = normalizedFragmentText(documentText);
  const targetEnd = Math.max(0,
    ...plan.sourceWordIntervals.map(({ end }) => end));
  const directiveParts = plan.directives.map((directive) =>
    directive.slice("text=".length).split(",")
  );
  const intervalsPerQuote = new Map<number, number>();
  for (const interval of plan.sourceWordIntervals) {
    intervalsPerQuote.set(interval.quoteIndex,
      (intervalsPerQuote.get(interval.quoteIndex) ?? 0) + 1);
  }
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return [
    docType === "laws" ? "law" : "case",
    url.hostname.toLocaleLowerCase("en"),
    fallbackUrlFamily(url),
    directiveParts.map((parts) => parts.length).join("/"),
    plan.sourceWordIntervals.length,
    [...intervalsPerQuote.values()].join("/"),
    plan.sourceSafeComplete ? "safe" : "partial",
    targetEnd <= 100 ? "opening" : targetEnd <= 1_000 ? "early" : "body",
    plan.paintQuotes.map((quote) => occurrenceClass(fullText, quote)).join("/"),
    directiveParts.map((parts) => parts.filter(Boolean)
      .map((part) => occurrenceClass(fullText, decode(part))).join("")).join("/"),
    plan.paintedWords,
    plan.paintQuotes.map(fragmentWordCount).join("/"),
    fragmentWordCount(blockText),
  ].join("|");
}

export function preferredPublisherPdfTarget(
  docType: A2AJCompiledDocument["docType"],
  target: string,
  plan: NativeTextFragmentPlan,
  documentText: string,
  blockText: string,
) {
  if (!isPdfSourceUrl(target) || plan.directives.length < 2) return null;
  const signature = fallbackSignature(docType, target, plan, documentText, blockText);
  const longest = PUBLISHER_PDF_LONGEST_FIRST_SIGNATURES.has(signature);
  const rarity = PUBLISHER_PDF_RARITY_FIRST_SIGNATURES.has(signature);
  if (!longest && !rarity) return null;
  const fullText = normalizedFragmentText(documentText);
  const ordered = plan.directives.map((directive, index) => ({
    directive,
    quote: plan.paintQuotes[index] ?? decodeURIComponent(directive.slice(5)),
  })).sort((left, right) => rarity
    ? fragmentOccurrences(fullText, left.quote) - fragmentOccurrences(fullText, right.quote) ||
      right.quote.length - left.quote.length
    : decodeURIComponent(right.directive).length - decodeURIComponent(left.directive).length
  ).map(({ directive }) => directive);
  return appendDirectives(target.split(":~:", 1)[0]!, ordered);
}

export function shouldUseA2AJWebFallback(
  docType: A2AJCompiledDocument["docType"],
  publisherUrl: string,
  publisherPlan: NativeTextFragmentPlan | null,
  documentText: string,
  blockText: string,
) {
  if (!publisherPlan?.directives.length) return false;
  const targetEnd = Math.max(0,
    ...publisherPlan.sourceWordIntervals.map(({ end }) => end));
  if (targetEnd > 200_001) return false;
  try {
    return LAW_WEB_FALLBACK_SIGNATURES.has(fallbackSignature(
      docType,
      publisherUrl,
      publisherPlan,
      documentText,
      blockText,
    ));
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
  const publisher = source.url
    ? buildLegalSourcePinpoint({
        url: source.url,
        docType: source.docType,
        verifiedPdf: source.verifiedPdf,
        anchor: legalSourceLocatorAnchor(source.url, locator.kind, locator.label),
        blockText,
        documentText: document,
      }, quotes, source.docType === "laws")
    : null;
  if (publisher && !shouldUseA2AJWebFallback(
    source.docType,
    publisher.target,
    publisher.plan,
    source.searchText,
    blockText,
  )) return publisher.target;
  const plan = structureNative().textFragmentPlan(
    blockText,
    quotes,
    false,
    false,
    true,
    document,
  );
  return buildA2AJWebPinpointUrl(source, plan) ?? publisher?.target ?? null;
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
    const fragmentPlan = (splitHtmlSourceBlocks: boolean) => {
      const args = [evidence.blockText, quotes, pdf,
        publisherMayAnnotateLegalReference(url), splitHtmlSourceBlocks] as const;
      return evidence.documentText
        ? structureNative().textFragmentPlan(...args, evidence.documentText)
        : structureNative().textFragmentPlanStandalone(...args);
    };
    const base = fragmentPlan(false);
    const [directive] = base.directives;
    const value = directive?.slice("text=".length) ?? "";
    const simpleRange = base.directives.length === 1 && value.split(",").length === 2 &&
      !value.includes("-,") && !value.includes(",-");
    if (!preferIndependentHtmlBlocks || pdf || !simpleRange || !evidence.documentText) {
      return base;
    }
    const blocks = fragmentPlan(true);
    const fullText = normalizedFragmentText(
      structureNative().documentText(evidence.documentText),
    );
    return blocks.sourceSafeComplete && blocks.directives.length >= 2 &&
      blocks.paintedWords === base.paintedWords && blocks.paintQuotes.every((quote) =>
        occurrenceClass(fullText, quote) === "1")
      ? blocks : base;
  };
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
  const target = appendDirectives(targetUrl, selected.directives);
  const preferred = evidence.docType && evidence.documentText
    ? preferredPublisherPdfTarget(
        evidence.docType,
        target,
        selected,
        structureNative().documentText(evidence.documentText),
        evidence.blockText,
      )
    : null;
  return { target: preferred ?? target, plan: selected };
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
