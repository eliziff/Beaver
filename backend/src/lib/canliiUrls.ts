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
    // A CanLII ID names its decision page once its court is written: "1961 CanLII 7 (SCC)".
    if (citation.form !== "full" || citation.format !== "neutral" && citation.format !== "can_lii") continue;
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

import { isCanliiUrl } from "mike/shared/runtime/canliiPageUrls.mjs";
