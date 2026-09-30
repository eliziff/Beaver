import { structureNative } from "./structureNative";
import sourceCanliiRoutes from "legal-citations/source-canlii-routes.json";
import type { ExtractResponse } from "legal-citations";

// The package copies this resource from the Rust engine's reviewed registry.
const courtRoutes: Record<string, string> = sourceCanliiRoutes.routes;

export function hasCanliiCourtRoute(court: string) {
  return Object.hasOwn(courtRoutes, court);
}

function resolvedCanliiCaseUrl(
  citations: Array<string | null | undefined>,
  language: "en" | "fr",
  expectedCourt?: string,
) {
  const native = structureNative();
  const result = native.citationEngineCall("extract", JSON.stringify({
    text: citations.filter(Boolean).join("\n;\n"), options: { resolve: false, parallel: false },
  })) as ExtractResponse;
  for (const citation of result.citations) {
    if (citation.form !== "full" || citation.format !== "neutral") continue;
    const court = citation.court?.text.toUpperCase();
    if (expectedCourt && court !== expectedCourt) continue;
    const { urls } = native.citationEngineCall("url", JSON.stringify({ citation, language })) as {
      urls: Array<{ url: string | null }>;
    };
    const url = urls[0]?.url;
    if (url && isCanliiUrl(url)) return url;

  }
  return null;
}

export function buildCanliiCaseUrl({
  dataset,
  citations,
  language,
}: {
  dataset: string;
  citations: Array<string | null | undefined>;
  language: "en" | "fr";
}) {
  const expectedCourt = dataset.trim().toUpperCase();
  return hasCanliiCourtRoute(expectedCourt)
    ? resolvedCanliiCaseUrl(citations, language, expectedCourt)
    : null;
}

export function buildCanliiCaseUrlFromCitation(
  citations: Array<string | null | undefined>,
  language: "en" | "fr" = "en",
) {
  return resolvedCanliiCaseUrl(citations, language);
}

/** A hostname ready to compare or print: lowercased, without the root's trailing dot. */
export const urlHostname = (value: string | URL) =>
  (typeof value === "string" ? new URL(value) : value).hostname.toLowerCase().replace(/\.+$/u, "");

/** CanLII serves from both registries and from any subdomain of either (www.canlii.org,
 *  primary.canlii.ca). The scheme is not part of the test, and a value that is not a URL
 *  is not CanLII. */
export function isCanliiUrl(value: string | URL) {
  let host;
  try { host = urlHostname(value); } catch { return false; }
  return ["canlii.ca", "canlii.org"].some((domain) =>
    host === domain || host.endsWith(`.${domain}`));
}

/** Returns only the exact PDF sibling of a canonical CanLII decision page. */
export function buildCanliiPdfUrl(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.canlii.org" || url.port ||
        url.username || url.password || url.search || url.hash) return null;
    const match = /^\/(?:en|fr)\/(?:[A-Za-z0-9-]+\/){1,2}doc\/(\d{4})\/([a-z0-9-]+)\/\2\.html$/u
      .exec(url.pathname);
    if (!match || !match[2].startsWith(match[1])) return null;
    url.pathname = url.pathname.replace(/\.html$/u, ".pdf");
    return url.href;
  } catch { return null; }
}
