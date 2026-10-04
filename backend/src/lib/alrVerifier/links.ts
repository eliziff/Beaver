// Citation links: A2AJ identity first (it also supplies the source text later), then the citation
// engine's CanLII URLs. Ported from alr_quote_verifier.py _resolve_footnote_part_link_unlocked,
// _a2aj_resolve_case_before_browser, _a2aj_case_link, _a2aj_has_law_before_browser,
// _a2aj_official_law_url and _generate_fallback_url. CanLII is never fetched.
import { buildCanliiLawUrl } from "mike/shared/runtime/canliiLawUrls.mjs";
import type { LegalSourceReference } from "../legalSources";
import { citations, citationUrl, engine, refKind } from "./engine";
import type { AlrSources } from "./sources";
import { appendFirstPinpoint, canliiLookupUrl, host, isCanlii, isUsableLink, splitUrl } from "./urls";

export type LinkRequest = { verbatim: string; citationWithStyle: string; kind: string; candidate: string;
  fragments: string[]; bare: string };
export type LockedSource = { reference: LegalSourceReference; kind: "case" | "legislation" };

const CASE_KINDS = new Set(["case", "unreported"]);
const LAW_KINDS = new Set(["statute", "gazette"]);

/** CanLII URL the engine builds for a neutral or CanLII citation (or a statute), "" when none. */
export function fallbackUrl(text: string, firstPinpoint: string, kind: string) {
  const found = citations(text);
  for (const citation of found) {
    if (citation.form !== "full" || (citation.format !== "neutral" && citation.format !== "can_lii")) continue;
    const link = citationUrl(citation, { anchor: true });
    if (link && isCanlii(link)) return firstPinpoint.startsWith("par") ? `${link.split("#")[0]}#${firstPinpoint}` : link;
  }
  if (LAW_KINDS.has(kind)) for (const citation of found) {
    if (citation.form !== "full" || !["statute", "regulation"].includes(citation.authority ?? "")) continue;
    const link = citationUrl(citation, { anchor: false });
    if (link && isCanlii(link)) return link;
  }
  return "";
}

/** The official human page for an A2AJ law whose source URL is a machine format, or "". */
function officialLawUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return ""; }
  if (!/^https?:$/u.test(parsed.protocol)) return "";
  const site = parsed.host.toLowerCase();
  if (site.endsWith("laws-lois.justice.gc.ca")) {
    const xml = /\/(eng|fra)\/XML\/([^/]+?)\.xml$/iu.exec(parsed.pathname);
    if (xml) {
      const language = xml[1].toLowerCase(), regulation = /^(?:SOR|SI|C\.?R\.?C\.?|DORS|TR)\b/iu.test(xml[2]);
      return `https://laws-lois.justice.gc.ca/${language}/${language === "fra" ? regulation ? "reglements" : "lois"
        : regulation ? "regulations" : "acts"}/${xml[2]}/`;
    }
  }
  if (site.endsWith("ontario.ca")) {
    const api = /\/laws\/api\/v2\/legislation\/en\/doc-search\/(statute|regulation)\/([^/?#]+)$/iu.exec(parsed.pathname);
    if (api) return `https://www.ontario.ca/laws/${api[1].toLowerCase()}/${api[2]}`;
  }
  if (site.endsWith("bclaws.gov.bc.ca") && parsed.pathname.replace(/\/+$/u, "").toLowerCase().endsWith("/xml"))
    return `https://${parsed.host}${parsed.pathname.replace(/\/+$/u, "").slice(0, -4)}`;
  return parsed.pathname.toLowerCase().endsWith(".xml") ? "" : url;
}

/** The citation A2AJ is asked for: the case's neutral, CanLII or S.C.R. citation, else the text itself. */
function caseIdentity(text: string) {
  const found = citations(text).find((citation) => citation.form === "full" &&
    (citation.format === "neutral" || citation.format === "can_lii" || citation.fields.reporterId === "scr"));
  return found?.span.text ?? "";
}
/** A statute or regulation citation without its pinpoints, as A2AJ's lookup accepts it. */
export function lawIdentity(text: string) {
  const found = citations(text).find((citation) => citation.form === "full" &&
    ["statute", "regulation"].includes(citation.authority ?? ""));
  return found?.span.text ?? engine<string>("stripCitationTail", { text });
}

export function createLinker(sources: AlrSources, options: { a2aj: boolean; usUk: boolean }) {
  /** Base URL (no fragment) → the A2AJ document that independently identifies it. */
  const locked = new Map<string, LockedSource>();
  const lock = (link: string, source: LockedSource) => {
    const [base] = splitUrl(canliiLookupUrl(link));
    if (base && !locked.has(base)) locked.set(base, source);
  };

  async function a2ajCase(text: string, candidate: string, fragments: string[]) {
    const identity = caseIdentity(text) || text;
    const language = (candidate ?? "").toLowerCase().includes("/fr/") ? "fr" : "en";
    const reference = await sources.resolve(identity, "case", language);
    if (!reference) return "";
    let link = "";
    for (const value of [reference.citation, reference.alternateCitation]) {
      const found = citations(value ?? "").find((citation) => citation.format === "neutral" &&
        (citation.fields.series ?? "").toUpperCase() === (reference.collection ?? "").toUpperCase());
      const url = found && citationUrl(found, { language });
      if (url && isCanlii(url)) { link = url; break; }
    }
    if (!link && reference.url && /^https?:\/\//iu.test(reference.url)) link = reference.url;
    if (!link) return "";
    link = appendFirstPinpoint(link, fragments);
    lock(link, { reference, kind: "case" });
    return link;
  }

  async function a2ajLaw(text: string, candidate: string) {
    if (/\/laws\/(?:astat|hstat)\//iu.test(candidate ?? "")) return null;
    const language = (candidate ?? "").toLowerCase().includes("/fr/") ? "fr" : "en";
    const reference = await sources.resolve(lawIdentity(text), "legislation", language);
    if (!reference) return null;
    const canlii = language === "en" ? buildCanliiLawUrl({ dataset: reference.collection ?? "",
      citation: reference.citation ?? null, language }) : null;
    return { reference, canlii: canlii ?? "", official: reference.url ? officialLawUrl(reference.url) : "" };
  }

  async function resolve(request: LinkRequest) {
    const kind = (request.kind ?? "").trim().toLowerCase();
    const text = request.citationWithStyle || request.verbatim;
    const first = request.fragments.map((value) => value.replace(/^#/u, "")).find(Boolean) ?? "";
    if (options.a2aj && CASE_KINDS.has(kind)) {
      const link = await a2ajCase(text, request.candidate, request.fragments);
      if (link) return link;
    } else if (options.a2aj && LAW_KINDS.has(kind)) {
      const law = await a2ajLaw(request.bare || text, request.candidate);
      if (law) {
        const existing = isUsableLink(request.candidate.trim()) ? request.candidate.trim() : "";
        const link = law.canlii || existing || law.official || fallbackUrl(text, first, kind);
        if (link) {
          if (law.canlii) lock(law.canlii, { reference: law.reference, kind: "legislation" });
          return appendFirstPinpoint(link, request.fragments);
        }
      }
    }
    const candidate = (request.candidate ?? "").trim();
    if (options.usUk && CASE_KINDS.has(kind) && (!isUsableLink(candidate) || isCanlii(candidate))) {
      const foreign = await sources.foreignCaseUrl(text);
      if (foreign) return foreign;
    }
    if (CASE_KINDS.has(kind) && citations(request.verbatim || text).some((citation) => citation.fields.reporterId === "scr")) {
      const override = fallbackUrl(request.verbatim || text, first, kind);
      if (override) return appendFirstPinpoint(override, request.fragments);
    }
    // No page resolver runs: the link is the candidate itself.
    let link = candidate;
    if (!isUsableLink(link)) {
      const fallback = fallbackUrl(text, first, kind);
      if (fallback) link = fallback;
    }
    return appendFirstPinpoint(link, request.fragments);
  }
  return { resolve, locked, lock, isReference: (text: string) => !!refKind(text), host };
}
export type Linker = ReturnType<typeof createLinker>;
